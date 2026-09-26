import { readFile } from "node:fs/promises";
import type { SchemaParser } from "@konteks/remote-common";
import { join } from "node:path";
import { CONTROL_SOCKET_DEFAULT_PORT, CONTROL_TOKEN_FILE_NAME, RemoteInstanceError, controlCall, type ControlCall, type ControlRequest } from "@konteks/remote-common";

/**
 * The launcher's view of the supervisor: the loopback control socket,
 * authenticated with the token the supervisor wrote into its private data
 * folder under the installation root.
 */
export class SupervisorControl {
  constructor(private readonly paths: { supervisorData: string }, private readonly port: number = Number(process.env.KONTEKS_CONTROL_PORT ?? CONTROL_SOCKET_DEFAULT_PORT)) {}

  private async token(): Promise<string> {
    try {
      return (await readFile(join(this.paths.supervisorData, CONTROL_TOKEN_FILE_NAME), "utf8")).trim();
    } catch (error) {
      throw new RemoteInstanceError("control_socket_unavailable", "the supervisor has not started yet (no control token)", { cause: error, recoveryActions: [{ kind: "run_doctor" }] });
    }
  }

  async call<T>(request: ControlRequest, schema: SchemaParser<T>, options: Partial<Omit<ControlCall<T>, "request" | "schema">> & { timeoutMs?: number } = {}): Promise<T> {
    const token = await this.token();
    return controlCall({ token, port: this.port, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, { request, schema, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
  }
}
