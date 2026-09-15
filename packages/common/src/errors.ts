import { z } from "zod";

/**
 * Stable error codes the appliance itself raises. Codes shared with Core come
 * from `wire-contracts.md` ("Stable error codes"); the launcher-only codes are
 * local operational diagnostics and never travel on the wire.
 */
export const RemoteInstanceErrorCodeSchema = z.enum([
  "workload_delegation_invalid", "workload_delegation_expired", "workload_delegation_revoked",
  "execution_authority_unavailable", "execution_not_ready", "execution_conflict", "execution_fenced",
  "operation_permit_required", "operation_permit_invalid", "operation_conflict", "operation_expired", "operation_interrupted",
  // Wire-contract codes the appliance raises or surfaces verbatim.
  "activation_expired",
  "activation_consumed",
  "activation_invalid",
  "registration_mismatch",
  "schema_invalid",
  "permission_denied",
  "not_found",
  "idempotency_conflict",
  "resume_deadline_expired",
  "conflict",
  "protocol_incompatible",
  "bundle_untrusted",
  "instance_draining",
  "instance_suspended",
  "instance_revoked",
  "instance_offline",
  "agent_auth_required",
  "agent_unavailable",
  "capability_unavailable",
  "workspace_binding_invalid",
  "assignment_conflict",
  "update_required",
  "temporarily_unavailable",
  "provisioning_credential_expired",
  "provisioning_window_expired",
  "key_rotation_invalid",
  "erase_incomplete",
  "configuration_stale",
  "gateway_unavailable",
  "relay_unavailable",
  "relay_replay_gap",
  "relay_epoch_stale",
  "permission_timeout",
  "permission_already_answered",
  "permission_schema_mismatch",
  "recovery_required",
  "preview_path_invalid",
  "preview_header_rejected",
  "report_out_of_order",
  "report_sequence_gap",
  "report_payload_conflict",
  "no_eligible_agent",
  "role_not_advertised",
  "agent_capability_missing",
  "reconciliation_replay",
  "active_work",
  "ownership_promotion_denied",
  "limit_exceeded",
  // D143 assignment transport dispositions, mirrored from the shared taxonomy.
  "assignment_channel_invalid",
  "assignment_sequence_gap",
  "assignment_replay_conflict",
  "assignment_replay_retired",
  "assignment_ack_out_of_bounds",
  "assignment_transport_capacity",
  // Local-only operational codes.
  "prerequisite_missing",
  "backend_unsupported",
  "control_socket_unauthorized",
  "control_socket_unavailable",
  "install_state_corrupt",
  "local_io_failure",
]);
export type RemoteInstanceErrorCode = z.infer<typeof RemoteInstanceErrorCodeSchema>;

export const RecoveryActionSchema = z
  .object({
    kind: z.enum([
      "retry",
      "run_doctor",
      "login_agent",
      "update",
      "free_disk",
      "install_backend",
      "new_activation",
      "contact_support",
      "revoke_in_app",
      "reselect_runtime",
    ]),
    agentId: z.string().min(1).optional(),
  })
  .strict();
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

/**
 * Every error the toolkit surfaces to an operator carries a stable code, a
 * redacted message, and bounded recovery actions — mirroring the Konteks error
 * envelope. The message is never allowed to carry a secret: callers build it
 * from codes and identifiers, never from raw command output.
 */
export class RemoteInstanceError extends Error {
  readonly code: RemoteInstanceErrorCode;
  readonly recoveryActions: RecoveryAction[];
  readonly retryable: boolean;
  /**
   * A bounded, static identifier of the exact check that refused, for logs
   * that must never carry message text (a message may embed bridge output).
   * One code such as `recovery_required` is raised from a dozen distinct
   * checks; without this a refusal is undiagnosable from the connector log.
   */
  readonly diagnostic?: string;

  constructor(
    code: RemoteInstanceErrorCode,
    message: string,
    options: { recoveryActions?: RecoveryAction[]; retryable?: boolean; cause?: unknown; diagnostic?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteInstanceError";
    this.code = code;
    this.recoveryActions = options.recoveryActions ?? [];
    this.retryable = options.retryable ?? false;
    if (options.diagnostic !== undefined) this.diagnostic = options.diagnostic;
  }

  toJSON(): { code: RemoteInstanceErrorCode; message: string; recoveryActions: RecoveryAction[] } {
    return { code: this.code, message: this.message, recoveryActions: this.recoveryActions };
  }
}

export function isRemoteInstanceError(error: unknown): error is RemoteInstanceError {
  return error instanceof RemoteInstanceError;
}

export function normalizeCaughtError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isFsErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
