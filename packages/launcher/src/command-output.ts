import { stripVTControlCharacters } from "node:util";
import { redactText } from "@konteks/remote-common";

// Match runCommand's capture bound, before parsing or decoding child output.
const INPUT_LIMIT = 256 * 1024;
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Native command diagnostics, decoded and redacted before either display bound. */
export function commandOutputText(text: string): string {
  const input = text.slice(0, INPUT_LIMIT);
  const decoded = powerShellErrors(input) ?? input;
  const plain = stripVTControlCharacters(decoded).replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\n" || char === "\t" ? char : "");
  return redactText(plain).trim();
}

/** PowerShell's native CLI sends Error strings beside serialized progress objects. */
function powerShellErrors(text: string): string | null {
  const document = /^\uFEFF?\s*#< CLIXML\s*<Objs\b([^>]*)>([\s\S]*)<\/Objs>\s*$/.exec(text);
  if (!document || /<!/.test(document[2]!) || !/\bxmlns=["']http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04["']/.test(document[1]!)) return null;
  const errors: string[] = [];
  for (const record of document[2]!.matchAll(/<S\s+([^<>]*)>([^<>]*)<\/S>/g)) {
    if (!/(?:^|\s)S\s*=\s*(?:"Error"|'Error')(?:\s|$)/.test(record[1]!)) continue;
    const decoded = decodePowerShellString(record[2]!);
    if (decoded === null) return null;
    errors.push(decoded);
  }
  return errors.length ? errors.join("\n") : null;
}

function decodePowerShellString(text: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);)/.test(text)) return null;
  try {
    const xml = text.replace(/&([^;]+);/g, (_match, entity: string) => xmlCharacter(entity));
    // One pass is essential: _x005F_x0041_ represents literal "_x0041_".
    return xml.replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  } catch {
    return null;
  }
}

function xmlCharacter(entity: string): string {
  const named = XML_ENTITIES[entity];
  if (named !== undefined) return named;
  const hexadecimal = entity.startsWith("#x");
  const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (value >= 0xd800 && value <= 0xdfff) throw new Error("Invalid XML character");
  return String.fromCodePoint(value);
}
