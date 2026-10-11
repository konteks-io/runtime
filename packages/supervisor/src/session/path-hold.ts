/**
 * An agent streams its words a few characters at a time, and a path in them
 * is split wherever the stream happens to break. Redacted chunk by chunk, the
 * session's own folder was never named `[workspace]`, and a break inside
 * "Application Support" leaked the rest ("I'm working in: [local-path]
 * Support/konteks-remote/workspaces/…/source", 10-11). A chunk that ends
 * inside a path holds that path back and sends it with the next chunk, so
 * redaction always sees a path whole.
 */

/** Where a token ends: as path detection reads it (activity.ts `TOKEN_DELIMITER`). */
const TOKEN_DELIMITER = /[\s"'<>`)[\]}=(]/;
const PATH_START = /^(?:\/(?![/*])|[A-Za-z]:(?:[\\/]|$)|\\\\)/;
/** A drive letter alone may be the start of `C:\…` split after its first character. */
const DRIVE_LETTER = /^[A-Za-z]$/;
/** A held path never grows past this: a runaway token goes out as it is. */
const MAX_HELD = 4_096;

/** The text to send now and the path it ends inside, held for the next chunk. */
export function splitTrailingPath(text: string): { ready: string; held: string } {
  const start = trailingPathStart(text);
  if (start === -1 || text.length - start > MAX_HELD) return { ready: text, held: "" };
  return { ready: text.slice(0, start), held: text.slice(start) };
}

function trailingPathStart(text: string): number {
  let end = text.length;
  // "…/Application", "…/Application " and "…/Application Supp" may be one path.
  const support = /[\\/]Application(?: S?u?p?p?o?r?t?)?$/.exec(text);
  if (support) end = support.index + "/Application".length;
  const start = tokenStart(text, end);
  if (text[start - 1] === "<") return -1; // a tag (`</h2>`), not a path
  const token = text.slice(start, end);
  if (PATH_START.test(token) || (end === text.length && DRIVE_LETTER.test(token))) return start;
  // "Support/…" after "/Application ": the path began before the space.
  if (/[\\/]Application $/.test(text.slice(0, start)) && /^Support(?:[\\/]|$)/.test(text.slice(start))) {
    const earlier = tokenStart(text, start - 1);
    if (text[earlier - 1] !== "<" && PATH_START.test(text.slice(earlier, start - 1))) return earlier;
  }
  return -1;
}

/** Where the token that ends at `end` starts. */
function tokenStart(text: string, end: number): number {
  let index = end - 1;
  while (index >= 0 && !TOKEN_DELIMITER.test(text[index]!)) index -= 1;
  return index + 1;
}

type ChunkParams = { sessionId: string; update: { sessionUpdate: string; content: { type: "text"; text: string } } & Record<string, unknown> };

/** Holds the path an agent's streamed reply ends inside until the next chunk, or until anything else happens. */
export class StreamedPathHold {
  private held: ChunkParams | null = null;

  /** The chunk to send now with any held path in front, holding the path it ends inside; null when all of it waits. */
  take(params: ChunkParams): ChunkParams | null {
    const text = (this.held?.update.content.text ?? "") + params.update.content.text;
    this.held = null;
    const { ready, held } = splitTrailingPath(text);
    if (held) this.held = withText(params, held);
    return ready ? withText(params, ready) : null;
  }

  /** The held path as its own chunk, before any other update or the turn's end. */
  flush(): ChunkParams | null {
    const held = this.held;
    this.held = null;
    return held;
  }
}

function withText(params: ChunkParams, text: string): ChunkParams {
  return { ...params, update: { ...params.update, content: { ...params.update.content, text } } };
}

/** An agent's own streamed words: the only chunks a path is held in. */
export function heldChunk(params: unknown): ChunkParams | null {
  const update = (params as { update?: { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } } } | null)?.update;
  return update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string"
    ? params as ChunkParams : null;
}
