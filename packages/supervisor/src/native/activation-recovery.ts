import { createLogger, jcsDigest, RemoteInstanceError, CoreResponseError, type InstanceKeyPair } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";
import { prepareActivationExchange, recordActivationExchange, type ActivationExchangeArgs, type ActivationExchangeOutcome } from "../provisioning/activation.js";
import { SupervisorStore } from "../state/store.js";
import { SupervisorJournal } from "../state/journal.js";
import { archiveRetiredActivation } from "./activation-retirement.js";
import type { NativeActivationArgs } from "./activation.js";

type Input = { args: NativeActivationArgs; store: SupervisorStore; journal: SupervisorJournal; key: InstanceKeyPair; core: CoreClient; owner: { assertOwned(): void } };

/** Keep the old key and lineage until Core either recovers that exact instance or fences its unused attempt. */
export async function recoverChangedActivation(input: Input): Promise<ActivationExchangeOutcome | null> {
  const { args, store, journal, key, core, owner } = input;
  const enrollment = journal.execution.enrollment();
  if (!enrollment || enrollment.keyDigest !== jcsDigest(key.publicKeyJwk as never)) throw preserved("The original enrollment key could not be confirmed.");
  if (!journal.execution.canRetireEnrollment()) throw preserved("This installation has execution history and requires its normal retirement flow.");
  const original: ActivationExchangeArgs = { ...args, activationId: enrollment.activationId, store, core, key, deploymentKind: "native_connector" };
  const { nonce } = await prepareActivationExchange(original);
  const activationCode = await args.readActivationCode();
  owner.assertOwned();
  const result = await requestRecovery(core, { previousActivationId: enrollment.activationId, activationId: args.activationId,
    activationCode, publicKeyJwk: key.publicKeyJwk, platform: args.platform, exchangeNonce: nonce });
  owner.assertOwned();
  if (result.state === "retired") {
    await archiveRetiredActivation(args.dataDir, { previousActivationId: enrollment.activationId, activationId: args.activationId, keyDigest: enrollment.keyDigest }, owner);
    return null;
  }
  const identity = await store.identity();
  if (identity && identity.instanceId !== result.exchange.instanceId) throw preserved("Core returned a different runtime identity.");
  return recordActivationExchange(original, result.exchange, nonce, createLogger({ name: "provisioning", level: "warn" }));
}

async function requestRecovery(core: CoreClient, request: Parameters<CoreClient["recoverActivation"]>[0]) {
  try {
    const result = await core.recoverActivation(request);
    if (result.previousActivationId !== request.previousActivationId || result.activationId !== request.activationId) throw preserved("Core returned a different enrollment recovery.");
    return result;
  }
  catch (error) {
    if (error instanceof CoreResponseError) throw new RemoteInstanceError("recovery_required", `The previous installation was kept (${error.wireCode}). Use a new activation from its original owner and workspace, then retry.`, { cause: error, recoveryActions: [{ kind: "new_activation" }] });
    throw error;
  }
}

function preserved(message: string): RemoteInstanceError {
  return new RemoteInstanceError("recovery_required", `${message} The original private state was preserved.`);
}
