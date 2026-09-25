/** Display-only naming Core sends with an assignment; never an IAM claim or a model instruction. */
export interface KonteksSessionLabel {
  system?: string | undefined;
  kind?: string | undefined;
  title?: string | undefined;
}

const MAX_TITLE = 160;
// "[konteks]" (legacy) or "[konteks/<system>/<kind>]"; the Codex ACP patch checks the same.
const KONTEKS_PREFIX = /^\[konteks[\]/]/u;

function clean(value: string | undefined): string {
  return (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Cut at a word boundary, never through a surrogate pair, marking the cut with an ellipsis. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "";
  let cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor((max - 1) / 2)) cut = cut.slice(0, space);
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** A path segment inside "[konteks/…]": no separators, no closing bracket. */
function segment(value: string | undefined, max: number): string {
  return truncate(clean(clean(value).replace(/[/[\]]/gu, " ")), max);
}

/** Display provenance only, never an IAM claim or a model instruction. */
export function konteksSessionTitle(title: string): string {
  const normalized = clean(title);
  return (KONTEKS_PREFIX.test(normalized) ? normalized : `[konteks] ${normalized || "Coding session"}`).slice(0, MAX_TITLE);
}

/**
 * The coding session's name in the person's own agent:
 * `[konteks/<system>/<kind>] <title> <shortRef>`, or the legacy
 * `[konteks] Coding session <shortRef>` when Core sent no label.
 */
export function konteksCodingSessionTitle(label: KonteksSessionLabel | undefined, shortRef: string): string {
  const ref = clean(shortRef).replace(/\s/gu, "").slice(0, 16);
  const scope = [segment(label?.system, 60), segment(label?.kind, 32)].filter(Boolean);
  const title = clean(label?.title);
  if (scope.length === 0 && !title) return konteksSessionTitle(`Coding session ${ref}`);
  const prefix = scope.length ? `[konteks/${scope.join("/")}]` : "[konteks]";
  const room = MAX_TITLE - prefix.length - 1 - (ref ? ref.length + 1 : 0);
  const body = truncate(title || "Coding session", room);
  return [prefix, body, ref].filter(Boolean).join(" ");
}

/** Provider adapters must persist this title through their native naming API. */
export function konteksSessionMetadata(title: string, agentId?: string) {
  const nativeTitle = konteksSessionTitle(title);
  return {
    konteksSession: { version: 1, title: nativeTitle },
    // Pinned claude-agent-acp forwards these to the SDK's native new-session
    // title and settings-source options. Login stays in the official profile,
    // but personal instructions/settings/hooks must not steer managed work.
    ...(agentId === "claude-code" ? { claudeCode: { options: { title: nativeTitle, settingSources: ["project"] } } } : {}),
  };
}
