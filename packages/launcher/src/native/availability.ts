import type { ConnectorAvailability, ConnectorAvailabilityPhase, ConnectorExpectedReturn, ConnectorHeartbeatSignal, ConnectorLivenessSignal, ConnectorRelaySignal, ConnectorUnavailabilityReason } from "@konteks/remote-common";
import { ConnectorAvailabilitySchema } from "@konteks/remote-common";
import type { Output } from "../output.js";
import { outputLocale, setupText, type SetupCopyKey, type SetupLocale } from "../setup-locale.js";
import type { SupervisorControl } from "../control.js";
import { readLocalServiceState, readServiceStartFailure, type LocalServiceState } from "./service-report.js";

/** How long a `control` command asks the connector for its availability. */
const AVAILABILITY_ASK_MS = 3_000;

/**
 * What a command that needs the running connector can learn about it: its own
 * answer when the control channel reaches it, otherwise this computer's own
 * files. Local evidence is what makes a connector that is not listening still
 * report a reason instead of a bare control_socket_unavailable.
 */
export interface AvailabilityProbe {
  read(): Promise<ConnectorAvailability>;
  /** Whether the service is running, from the service manager alone. */
  running(): Promise<boolean>;
}

export class NativeAvailability implements AvailabilityProbe {
  constructor(private readonly options: { control: Pick<SupervisorControl, "call">; root: string; running: () => Promise<boolean> }) {}

  async read(): Promise<ConnectorAvailability> {
    // A connector from before `availability.status` answers with an error:
    // the local files are then the only evidence this computer has.
    const asked = await this.options.control.call({ op: "availability.status" }, ConnectorAvailabilitySchema, { timeoutMs: AVAILABILITY_ASK_MS }).catch(() => null);
    return asked ?? localAvailability(this.options.root, await this.options.running());
  }

  running(): Promise<boolean> {
    return this.options.running();
  }
}

/**
 * The reason this computer can prove while the connector cannot answer, from
 * the files the supervisor already writes. `running` is null where the caller
 * cannot ask the service manager.
 */
export async function localAvailability(root: string, running: boolean | null): Promise<ConnectorAvailability> {
  const [state, startFailure] = await Promise.all([readLocalServiceState(root), readServiceStartFailure(root)]);
  // A running process's control channel is the only current evidence: a
  // failed start, an exit and a shutdown marker all describe another process.
  if (running === true) return missingControl();
  if (startFailure) {
    return unavailable("degraded", "lost", { code: "service_start_failed", message: `its service could not start at ${startFailure.at}: ${startFailure.message}` }, "a start that failed has no return time; konteks-remote start tries again");
  }
  const motion = latestMotion(state);
  if (motion !== null) return motion;
  if (running === false) return unavailable("degraded", "lost", { code: "service_stopped", message: "its service is not running on this computer" }, "the connector has not reported when it returns; konteks-remote start starts it");
  return missingControl();
}

/** The most recent exit or shutdown marker the supervisor wrote, when nothing newer proves otherwise. */
function latestMotion(state: LocalServiceState): ConnectorAvailability | null {
  const exitAt = state.lastExit === null ? Number.NaN : Date.parse(state.lastExit.occurredAt);
  const shutdownAt = state.shutdownProgress === null ? Number.NaN : Date.parse(state.shutdownProgress.observedAt);
  if (state.lastExit !== null && !(shutdownAt > exitAt)) return exitedAvailability(state.lastExit);
  if (state.shutdownProgress !== null && !state.shutdownComplete) return shutdownAvailability(state.shutdownProgress);
  return null;
}

/**
 * A process that ended on its own. Only the exit `daemon.ts` classifies as
 * `liveness_lost` is reported in that phase; any other exit is `degraded`,
 * because this computer cannot claim the watchdog lost liveness.
 */
function exitedAvailability(lastExit: { reason: string; occurredAt: string }): ConnectorAvailability {
  if (lastExit.reason === "liveness_lost") {
    return unavailable("liveness_lost", "lost", { code: "liveness_lost", message: `it lost its heartbeat at ${lastExit.occurredAt} and was restarted` }, "the restarted process reports its own return");
  }
  return unavailable("degraded", "lost", { code: "process_exited", message: `its process stopped at ${lastExit.occurredAt} (${lastExit.reason})` }, "the connector has not reported when it returns");
}

function shutdownAvailability(progress: NonNullable<LocalServiceState["shutdownProgress"]>): ConnectorAvailability {
  return unavailable("draining", "lost", { code: "shutdown_in_progress", message: `it was shutting down and reached ${progress.phase} (${progress.state}) at ${progress.observedAt}` }, "a shutdown in progress has no return time it can promise");
}

/** No answer and no marker that names a cause: the control channel itself is missing. */
function missingControl(): ConnectorAvailability {
  return unavailable("starting", "unknown", { code: "control_socket_unavailable", message: "its control socket on this computer did not answer" }, "the connector has not reported a return time yet");
}

function unavailable(
  phase: ConnectorAvailabilityPhase,
  liveness: ConnectorLivenessSignal["state"],
  reason: ConnectorUnavailabilityReason,
  why: string,
): ConnectorAvailability {
  return {
    available: false, phase, reason, expectedReturn: { kind: "unknown", why },
    liveness: { state: liveness, quietMs: null }, heartbeat: UNKNOWN_HEARTBEAT, relay: UNKNOWN_RELAY,
  };
}

/** No control answer means no publisher evidence; saying so beats inventing a heartbeat. */
const UNKNOWN_HEARTBEAT: ConnectorHeartbeatSignal = { state: "unknown", lastAttemptAt: null, lastSettledAt: null, budgetMs: null };
const UNKNOWN_RELAY: ConnectorRelaySignal = { state: "unknown", lastConnectedAt: null };

const PHASE_WORDS: Readonly<Record<ConnectorAvailabilityPhase, SetupCopyKey>> = {
  starting: "availabilityPhaseStarting",
  recovering: "availabilityPhaseRecovering",
  draining: "availabilityPhaseDraining",
  degraded: "availabilityPhaseDegraded",
  liveness_lost: "availabilityPhaseLivenessLost",
};

/** The words for one unavailability answer, in the given language. */
export function availabilityWords(
  locale: SetupLocale,
  availability: ConnectorAvailability,
): { phase: string; reason: string; when: string } {
  return {
    phase: availability.phase === null ? "" : setupText(PHASE_WORDS[availability.phase], {}, locale),
    reason: availability.reason?.message ?? "",
    when: expectedReturnWords(availability.expectedReturn, locale),
  };
}

/** One human line: the reason, its phase, and either a return time or that it is unknown. */
export function availabilityLine(output: Partial<Pick<Output, "json" | "setupLocale">>, availability: ConnectorAvailability): string {
  const locale = outputLocale(output);
  return setupText("availabilityUnavailable", availabilityWords(locale, availability), locale);
}

/** The same line in canonical English, for replies this launcher does not localize (onboarding). */
export function availabilityText(availability: ConnectorAvailability): string {
  return setupText("availabilityUnavailable", availabilityWords("en", availability), "en");
}

function expectedReturnWords(expectedReturn: ConnectorExpectedReturn, locale: SetupLocale): string {
  if (expectedReturn.kind === "at") return setupText("availabilityReturnsBy", { at: expectedReturn.at }, locale);
  return setupText("availabilityReturnUnknown", { why: expectedReturn.why }, locale);
}
