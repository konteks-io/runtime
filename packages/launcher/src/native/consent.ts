import { createInterface } from "node:readline";
import { affirmative, setupError, setupLocale, setupText, type SetupLocale } from "../setup-locale.js";

/**
 * The person's answer to a fetched agent's consent line:
 * `konteks-remote agent add antigravity` and `install --agents …,antigravity`
 * show its complete localized consent and download only on an
 * explicit yes. In a terminal the person answers it; `--yes` is that answer
 * given up front by the person (a relaying coding agent never adds it for
 * them, bootstrap/connect.md), and the line is still shown. Anything else, a
 * closed input included, is no.
 */
export type FetchConsent = (agentId: string, text: string) => Promise<boolean>;

export function terminalFetchConsent(options: {
  yes?: boolean;
  line: (text: string) => void;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  locale?: SetupLocale;
}): FetchConsent {
  const locale = options.locale ?? setupLocale();
  return async (agentId, text) => {
    const question = consentQuestion(agentId, text, locale);
    if (options.yes === true) {
      options.line(question);
      options.line(setupText("consentYes", {}, locale));
      return true;
    }
    const input = options.input ?? process.stdin;
    if (options.input === undefined && (input as NodeJS.ReadStream).isTTY !== true) {
      options.line(question);
      throw setupError("agent_unavailable", "consentMissing");
    }
    const rl = createInterface({ input, output: options.output ?? process.stderr, terminal: false });
    try {
      const answer = await new Promise<string>(resolve => {
        rl.once("close", () => resolve(""));
        rl.question(`${question} `, resolve);
      });
      return affirmative(answer, locale);
    } finally {
      rl.close();
    }
  };
}

function consentQuestion(agentId: string, text: string, locale: SetupLocale): string {
  // An unknown/provider-owned consent stays verbatim; this exact Konteks
  // contract is the only fetched-agent paragraph the launcher owns.
  if (agentId === "antigravity" && text === setupText("antigravityConsent", {}, "en")) return setupText("antigravityConsent", {}, locale);
  return text;
}
