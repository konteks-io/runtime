import { integrationError, type IntegrationError, type IntegrationErrorCode } from "@konteks/backstage-plugin-common";

/**
 * A task outcome the carrier reports as the result's stable `error`
 * (wire-contracts "Stable errors"), not as a failed assignment: the task was
 * genuine and ran to an honest answer that it could not do what was asked.
 * `params` are safe display values only (the shared schema refuses
 * credential-bearing keys).
 */
export class IntegrationTaskError extends Error {
  constructor(readonly code: IntegrationErrorCode, readonly params?: Record<string, string>) {
    super(`integration task: ${code}`);
    this.name = "IntegrationTaskError";
  }

  toResultError(): IntegrationError {
    return integrationError(this.code, this.params);
  }
}
