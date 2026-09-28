import { createInterface } from "node:readline";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * The person's answer to a fetched agent's consent line (antigravity A20):
 * `konteks-remote agent add antigravity` and `install --agents …,antigravity`
 * show the line exactly as written (it ends "[y/N]") and download only on an
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
}): FetchConsent {
  return async (_agentId, text) => {
    if (options.yes === true) {
      options.line(text);
      options.line("Answered yes with --yes.");
      return true;
    }
    const input = options.input ?? process.stdin;
    if (options.input === undefined && (input as NodeJS.ReadStream).isTTY !== true) {
      options.line(text);
      throw new RemoteInstanceError("agent_unavailable", "Nothing was downloaded: answer the question above in a terminal, or run the command again with --yes once you agree.");
    }
    const rl = createInterface({ input, output: options.output ?? process.stderr, terminal: false });
    try {
      const answer = await new Promise<string>(resolve => {
        rl.once("close", () => resolve(""));
        rl.question(`${text} `, resolve);
      });
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}
