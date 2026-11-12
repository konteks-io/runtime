import { redactText } from "./redaction.js";

const PREFIXES = ["sk-", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "eyJ", "kxrp_", "Bearer"];
const withStars = (value: string) => [...value].join("\\**");
const PARTIALS = [...new Set(PREFIXES.flatMap(prefix => [...prefix].map((_, index) => prefix.slice(0, index + 1))))];
const PARTIAL_END = new RegExp(`\\b(?:${PARTIALS.map(withStars).join("|")})\\**$`, "i");
const SECRET_END = new RegExp(`\\b(?:${PREFIXES.filter(prefix => prefix !== "Bearer").map(withStars).join("|")})[A-Za-z0-9_.*~/+=-]*$`, "i");
const BEARER_END = /\bbearer\s+[A-Za-z0-9_.*/~+=-]*$/i;
const CONTINUATION = /^[A-Za-z0-9_.*/~+=-]*/;
const MAX_PENDING = 4_096;

function pendingStart(text: string): number {
  return Math.min(text.length, ...[SECRET_END, BEARER_END, PARTIAL_END].map(pattern => pattern.exec(text)?.index ?? text.length));
}

/** Hold only a possible credential's trailing token, never an entire answer.
 * A candidate exceeding the bound is masked and its continuation discarded.
 */
export class SecretTextStream {
  private pending = "";
  private suppressing = false;
  private atBoundary = true;

  push(text: string): string {
    const rest = this.afterSuppressed(text);
    if (rest.length === 0) return "";
    const combined = this.pending + rest;
    const sentinel = this.atBoundary ? "" : "0";
    const probe = sentinel + combined;
    const start = pendingStart(probe);
    this.pending = probe.slice(start);
    const safe = probe.slice(0, start);
    const output = redactText(safe).slice(sentinel.length);
    if (safe.length > sentinel.length) this.atBoundary = !/[A-Za-z0-9_]$/.test(safe);
    if (this.pending.length <= MAX_PENDING) return output;
    this.pending = "";
    this.suppressing = true;
    return `${output}[redacted]`;
  }

  /** A lifecycle event must not carry half a possible key out before its tail. */
  interrupt(): string {
    if (this.pending.length === 0) return "";
    this.pending = "";
    this.suppressing = true;
    return "[redacted]";
  }

  finish(): string {
    const output = redactText(this.pending);
    this.pending = "";
    this.suppressing = false;
    this.atBoundary = true;
    return output;
  }

  private afterSuppressed(text: string): string {
    if (!this.suppressing) return text;
    const prefix = CONTINUATION.exec(text)![0];
    if (prefix.length === text.length) return "";
    this.suppressing = false;
    return text.slice(prefix.length);
  }
}
