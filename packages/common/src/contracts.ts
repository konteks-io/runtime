/**
 * The single boundary between this toolkit and the canonical shared contract
 * package. Every wire type, schema, constant, and error code the runtime
 * uses is imported here by its exact `wire-contracts.md` name and re-exported;
 * no other module in this repository imports `@konteks/backstage-plugin-common`
 * directly. If CP1 lands a name differently, this file is the only place that
 * changes.
 *
 * Schemas follow the shared package's `<Name>Schema` convention (see
 * `CapEnforcementStageSchema`, `RuntimeKindSchema`). Types are the wire names.
 */
export { AcpNativeObservationSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
export { RuntimeRoleSchema, RemoteWorkKindSchema } from "@konteks/backstage-plugin-common";
export type {
  RuntimePermissionAnswerDeliveryRequest,
  NativeCancellationReceipt,
  NativeCancellationReceiptRequest,
  NativeCancellationReceiptResult,
  RuntimeCancellationIntent,
  RuntimeCancellationDeliveryRequest,
  RuntimeCancellationDeliveryResult,
  ExecutionRevisionControlReason,
  RemoteExecutionRevisionControlIntent,
  RemoteExecutionRevisionControlDeliveryRequest,
  RemoteExecutionRevisionControlDeliveryResult,
  NativeExecutionRevisionFenceReceipt,
  NativeExecutionRevisionFenceReceiptRequest,
  NativeExecutionRevisionFenceReceiptResult,
  RemoteExecutionOperationDisposition,
  RemoteExecutionAuthorityView,
  RemoteExecutionOperationPermitClaims,
  RemoteExecutionAdmissionClaims,
  RemoteExecutionConsumeRequest,
  RemoteExecutionConsumeResult,
  RemoteExecutionCheckRequest,
  RemoteExecutionCheckResult,
  RemoteAuthorizedOperation,
  RemoteExecutionReadyRequest,
  RemoteExecutionReadyResult,
  RemoteAssignmentInputSelection,
  RemoteAssignmentInputsEnvelope,
  RemoteAssignmentInputsPrepareRequest,
  RemoteAssignmentInputsReadRequest,
  RemoteRepositoryFetchCapability,
  RemoteRepositoryFetchRequest,
  RemoteFileEntry,
  RemoteFileTree,
  RemoteDeliveryResultCandidate,
  RemoteDeliveryOutputPrepareRequest,
  RemoteDeliveryOutputPrepareResult,
  RemoteDeliveryOutputCommitRequest,
  RemoteDeliveryAcceptanceReceipt,
  RemoteDeliveryOutputStatusRequest,
  RemoteDeliveryOutputStatusResult,
  RemoteTransferBinding,
  RemoteTransferManifest,
  RemoteSkillCatalog,
  // State model and projections
  RemoteInstanceAdministrativeStatus,
  RemoteInstanceConnectivityStatus,
  RemoteInstanceHealthStatus,
  RemoteComponentKind,
  RemoteWorkKind,
  RuntimeRole,
  OwnershipScope,
  ConnectedAgentView,
  RuntimeUtilization,
  RemoteInstanceView,
  RemoteInstanceComponentView,
  // Provisioning, readiness, lease
  RemoteInstanceActivationExchangeRequest,
  RemoteInstanceActivationExchangeResult,
  RemoteSignedBundleManifest,
  RemoteNativeArtifact,
  AgentModelCapabilityMapping,
  AgentModelOfferedValuesSnapshot,
  RemoteInstanceProvisioningCredentialRefreshRequest,
  RemoteInstanceProvisioningCredentialRefreshResult,
  RemoteInstanceReadinessRequest,
  RemoteLeaseMode,
  RemoteInstanceLeaseClaims,
  // Reconnect and recovery
  RemoteRuntimeOwnerResolveRequest,
  RemoteRuntimeOwnerResolveResult,
  RemoteRuntimeEstablishmentPrecondition,
  RemoteReconciliationConnection,
  RemoteReconciliationAppliedRequest,
  RemoteReconciliationAppliedResult,
  RemoteRecoveryEvidence,
  RemoteReconciliationDecisionResult,
  RemoteReconciliationTerminalEvidence,
  RemoteReconnectIntentSnapshot,
  RemoteReconciliationReceiptSnapshot,
  RemoteInstanceReconnectRequest,
  RecoveryRequiredReason,
  RecoveryDecision,
  RemoteInstanceReconciliationManifest,
  // Relay transport
  RelayChannel,
  RelayFrameBase,
  ToCoreRelayFrame,
  ToRuntimeRelayFrame,
  RelayFrame,
  RelayAck,
  RelayEnvelope,
  RelayHandshakeRequest,
  RelayHandshakeResult,
  RelayRuntimeHandshakeResult,
  RelayReplayRequest,
  ControlAck,
  DrainDirective,
  VersionPolicy,
  HeartbeatMessage,
  HeartbeatResult,
  AssignmentPull,
  WorkAvailable,
  AssignmentClaim,
  ClaimDenialReason,
  ClaimResult,
  BoundedJsonValue,
  AssignmentFailureReason,
  AssignmentInterruptReason,
  AssignmentReport,
  ReportAck,
  CancelDirective,
  SupportChunk,
  AcpJsonRpcError,
  SessionToCoreMessage,
  SessionToRuntimeMessage,
  RelayedAcpMethod,
  // Closed control protocol
  DesiredConfigurationEnvelope,
  DesiredConfigurationAck,
  VersionAcknowledgement,
  InstanceKeyRotationChallenge,
  InstanceKeyRotationComplete,
  EraseDirective,
  EraseReceipt,
  // Work protocol
  RemoteWorkAssignment,
  RemoteSessionLabel,
  // Permissions (D102)
  PendingPermissionView,
  PermissionAnswerRequest,
  PlanningControllerTerminalDirective,
  PlanningControllerDirectivePullRequest,
  PlanningControllerDirectivePullResult,
  RemoteInstanceProofMethod,
  // Report verdict table (D125), applied locally to component-minted reports
  ClaimReportLedger,
  DurableReportRow,
  ReportVerdict,
  // Economics
  AgentTurnUsageObservation,
  // Existing shared enums
  RemoteCapEnforcementStage as CapEnforcementStage,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// D143 logical assignment identities. Authentication and accepting owners remain separate.
export {
  RemoteDeliveryExecutionAuthorityViewSchema, RemoteDeliveryAdmissionClaimsSchema,
  verifyRemoteDeliveryOperationSignature, verifyRemoteDeliveryAdmission, verifyRemoteDeliveryAdmissionEvidence, verifyRemoteDeliveryCheckLease,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  RemoteDeliveryExecutionAuthorityView, RemoteDeliveryAdmissionClaims, RemoteDeliveryOperationPermitClaims,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export {
  RuntimePermissionAnswerDeliveryRequestSchema,
  runtimePermissionAnswerMatches,
  computeRemoteExecutionOperationDigest,
  RuntimeCancellationIntentSchema,
  NativeCancellationReceiptSchema,
  NativeCancellationReceiptRequestSchema,
  NativeCancellationReceiptResultSchema,
  runtimeCancellationIntentDigest,
  RuntimeCancellationDeliveryRequestSchema,
  REMOTE_CANCELLATION_DELIVERY_CAPABILITY,
  // A coding agent login the person starts on this machine from the site (WS1-115).
  REMOTE_AGENT_LOGIN_CAPABILITY,
  REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY,
  AGENT_LOGIN_METHOD,
  RuntimeAgentLoginDeliveryRequestSchema,
  type RuntimeAgentLoginDeliveryRequest,
  RuntimeAgentLoginReportSchema,
  AgentLoginUserCodeSchema,
  agentLoginUrlAllowed,
  EXECUTION_REVISION_CONTROL_SCHEMA_VERSION,
  EXECUTION_REVISION_CONTROL_CAPABILITY,
  EXECUTION_REVISION_CONTROL_MAX_DELIVERY_MS,
  ExecutionRevisionControlReasonSchema,
  RemoteExecutionRevisionControlIntentSchema,
  computeExecutionRevisionControlIntentDigest,
  RemoteExecutionRevisionControlDeliveryRequestSchema,
  executionRevisionControlSigningBytes,
  RemoteExecutionRevisionControlDeliveryResultSchema,
  NativeExecutionRevisionFenceReceiptSchema,
  NativeExecutionRevisionFenceReceiptRequestSchema,
  NativeExecutionRevisionFenceReceiptResultSchema,
  RemoteExecutionAuthorityViewSchema,
  RemoteExecutionOperationPermitClaimsSchema,
  RemoteExecutionAdmissionClaimsSchema,
  RemoteExecutionConsumeRequestSchema,
  RemoteExecutionConsumeResultSchema,
  RemoteExecutionCheckRequestSchema,
  RemoteExecutionCheckResultSchema,
  RemoteAuthorizedOperationSchema,
  verifyRemoteExecutionOperationSignature,
  verifyRemoteExecutionOperationPermit,
  verifyRemoteExecutionAdmission, verifyRemoteExecutionAdmissionEvidence,
  verifyRemoteExecutionCheckLease,
  remoteExecutionInstanceProofSubject,
  REMOTE_EXECUTION_PERMITS_CAPABILITY,
  REMOTE_DELIVERY_PERMITS_CAPABILITY,
  LogicalAssignmentRequestFrameSchema, AssignmentRequestOriginSchema, AssignmentClaimSchema,
  AssignmentRequestReferenceSchema, AssignmentRequestFrameSchema, logicalAssignmentRequestDigest,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  LogicalAssignmentRequestFrame, AssignmentRequestFrame, AssignmentRequestOrigin, AssignmentRequestReference,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// D143 pending claim recovery inventory. Parsing proves local relations only:
// Core authority, coverage and pre-execution qualification remain owner checks.
export {
  PendingClaimAdmissionSchema, PendingClaimRequestSchema, PendingClaimReferenceSchema,
  PendingClaimDecisionSchema, PendingClaimResultSchema, PendingClaimFenceEvidenceSchema,
  derivePendingClaimReference,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  PendingClaimAdmission, PendingClaimRequest, PendingClaimReference,
  PendingClaimDecision, PendingClaimResult, PendingClaimFenceEvidence,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// Correlated transport replies. Acceptance of an envelope is not domain proof.
export {
  AssignmentTransportReplySchema, AssignmentResponseReferenceSchema,
  AssignmentRequestKindSchema, logicalAssignmentResponseDigest,
  LogicalAssignmentReplyFrameSchema, AssignmentReplyFrameSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  AssignmentTransportReply, AssignmentResponseReference, AssignmentRequestKind,
  LogicalAssignmentReplyFrame, AssignmentReplyFrame,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// The native HTTPS carrier. Establishing native's own authority, never a relay's.
export {
  NativeAssignmentRequestSchema, NativeAssignmentResultSchema,
  NativeAssignmentAckRequestSchema, NativeAssignmentAckResultSchema,
  NativeCoreRequestAckSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  NativeAssignmentRequest, NativeAssignmentResult,
  NativeAssignmentAckRequest, NativeAssignmentAckResult,
  NativeCoreRequestAck,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

export {
  RemoteExecutionReadyRequestSchema,
  RemoteExecutionReadyResultSchema,
  RemoteAssignmentInputSelectionSchema,
  RemoteAssignmentInputsEnvelopeSchema,
  RemoteAssignmentInputsPrepareRequestSchema,
  RemoteAssignmentInputsReadRequestSchema,
  RemoteRepositoryFetchCapabilitySchema,
  RemoteRepositoryFetchRequestSchema,
  computeRemoteAssignmentInputSelectionDigest,
  REMOTE_INPUT_METADATA_MAX_BYTES,
  REMOTE_INPUT_TREE_MAX_BYTES,
  REMOTE_REPOSITORY_BUNDLE_MAX_BYTES,
  remoteControlSigningBytes,
  RemoteControlSigningKeySchema,
  REMOTE_FILE_TREE_LIMITS,
  REMOTE_INSTANCE_LIMITS,
  RemoteFileTreeSchema,
  RemoteDeliveryResultCandidateSchema,
  RemoteDeliveryOutputPrepareRequestSchema,
  RemoteDeliveryOutputPrepareResultSchema,
  RemoteDeliveryOutputCommitRequestSchema,
  RemoteDeliveryAcceptanceReceiptSchema,
  RemoteDeliveryOutputStatusRequestSchema,
  RemoteDeliveryOutputStatusResultSchema,
  computeRemoteDeliveryOutputDigest,
  RemoteTransferPathSchema,
  RemoteNativeArtifactSchema,
  AgentModelCapabilityMappingSchema,
  AgentModelOfferedValuesSnapshotSchema,
  agentModelCapabilityMappingSigningBytes,
  computeAgentModelCapabilityMappingDigest,
  computeAgentModelOfferedValuesSnapshotDigest,
  catalogueModelAuthority,
  RemoteTransferBindingSchema,
  RemoteTransferManifestSchema,
  RemoteSkillCatalogSchema,
  computeRemoteFileTreeDigest,
  computeRemoteTransferManifestDigest,
  computeRemoteSkillCatalogDigest,
  validateRemoteTransfer,
  // Strict parsers for every trust boundary the runtime validates.
  RemoteInstanceActivationExchangeResultSchema,
  RemoteSignedBundleManifestSchema,
  computeBundleManifestDigest,
  bundleManifestSigningBytes,
  verifyBundleManifestTrust,
  RemoteInstanceProvisioningCredentialRefreshResultSchema,
  RemoteInstanceReconciliationManifestSchema,
  RemoteInstanceReconnectRequestSchema,
  RemoteRuntimeOwnerResolveRequestSchema,
  RemoteRuntimeOwnerResolveResultSchema,
  RemoteReconciliationAppliedRequestSchema,
  RemoteReconciliationConnectionSchema,
  RemoteReconciliationAppliedResultSchema,
  RemoteRecoveryEvidenceSchema,
  computeRemoteRecoveryEvidenceDigest,
  remoteRecoveryEvidenceIdentityKey,
  RemoteReconnectIntentSnapshotSchema,
  RemoteReconciliationReceiptSnapshotSchema,
  computeRemoteReconnectIntentDigest,
  computeRemoteReconciliationManifestDigest,
  computeRemoteReconciliationReceiptDigest,
  computeRemoteReconnectSnapshotDigest,
  computeRemoteReconciliationReceiptSnapshotDigest,
  RecoveryDecisionSchema,
  ToRuntimeRelayFrameSchema,
  ToCoreRelayFrameSchema,
  RelayAckSchema,
  RelayHandshakeResultSchema,
  RelayRuntimeHandshakeResultSchema,
  RelayReplayRequestSchema,
  RemoteWorkAssignmentSchema,
  REMOTE_SESSION_LABEL_CAPABILITY,
  RemoteSessionLabelSchema,
  WorkAvailableSchema,
  ClaimResultSchema,
  ReportAckSchema,
  CancelDirectiveSchema,
  DrainDirectiveSchema,
  VersionPolicySchema,
  DesiredConfigurationEnvelopeSchema,
  DesiredConfigurationSchema,
  DesiredConfigurationAckSchema,
  DesiredConfigurationAckResultSchema,
  InstanceKeyRotationChallengeSchema,
  EraseDirectiveSchema,
  SessionToRuntimeMessageSchema,
  SessionToCoreMessageSchema,
  PendingPermissionViewSchema,
  PermissionAnswerRequestSchema,
  PlanningControllerTerminalDirectiveSchema,
  PlanningControllerDirectivePullRequestSchema,
  PlanningControllerDirectivePullResultSchema,
  planningControllerTerminalDirectiveSigningBytes,
  BoundedJsonValueSchema,
  AgentTurnUsageObservationSchema,
  HeartbeatMessageSchema,
  HeartbeatResultSchema,
  RemoteAgentCapabilityRedeemRequestSchema,
  RemoteAgentCapabilityRedeemResultSchema,
  RemoteInstanceLeaseClaimsSchema,
  RemoteLeaseModeSchema,
  AssignmentPullSchema,
  AssignmentReportSchema,
  ConnectedAgentViewSchema,
  RemoteInstanceComponentViewSchema,
  RuntimeUtilizationSchema,
  RemoteCapEnforcementStageSchema as CapEnforcementStageSchema,
  // The instance-proof profile: the audience, the version, and the closed
  // OPERATION names both sides sign. Published by CP1 so neither Core nor the
  // supervisor re-derives it (they previously disagreed and no proof matched).
  REMOTE_INSTANCE_PROOF_AUDIENCE,
  REMOTE_INSTANCE_PROOF_VERSION,
  REMOTE_INSTANCE_PROOF_METHODS,
  // The ordered D125 verdict table as a pure function: the supervisor applies
  // it to component-minted reports exactly as Core applies it to its own.
  decideReportVerdict,
  DiagnosticCarrierCompanionSchema,
  DiagnosticCarrierCompanionDeliveryRequestSchema,
  DiagnosticCarrierCompanionDeliveryResultSchema,
  diagnosticCarrierCompanionSigningBytes,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  DiagnosticCarrierCompanion,
  DiagnosticCarrierCompanionDeliveryRequest,
  DiagnosticCarrierCompanionDeliveryResult,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

/**
 * Wire constants that CP1 publishes (protocol negotiation, ACP schema
 * version, frame/list bounds). Re-exported so the runtime never hard-codes
 * a value the control plane also owns.
 */
export {
  RemotePlatformSchema,
  REMOTE_INSTANCE_PROTOCOL_VERSION,
  REMOTE_LEASE_AUDIENCE as REMOTE_INSTANCE_LEASE_AUDIENCE,
  RELAYED_ACP_METHODS,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

/**
 * Onboarding (onboarding-mode OB1). The `onboard` role reads repositories and
 * moves them, so the runtime needs the discovery-run vocabulary, the evidence
 * submission shape it is allowed to send (deliberately WITHOUT `collectedBy`,
 * which Core stamps), and the two tool contracts OB1 published by name.
 */
export {
  DiscoveryDepthSchema,
  DiscoveryRunBoundsSchema,
  DiscoveryInventoryItemSchema,
  DiscoveryEvidenceFactsSchema,
  DiscoveryEvidenceSubmissionSchema,
  EnrichmentProgressInputSchema,
  RepositoryRelocateReportInputSchema,
  MANAGED_REPOSITORY_CREATE_TOOL,
  REPOSITORY_RELOCATE_PROPOSE_TOOL,
  REPOSITORY_RELOCATE_REPORT_TOOL,
  REPOSITORY_RELOCATE_STATUS_TOOL,
} from "@konteks/backstage-plugin-common";
export type {
  DiscoveryDepth,
  DiscoveryRunBounds,
  DiscoveryInventoryItem,
  DiscoveryEvidenceFacts,
  DiscoveryEvidenceSubmission,
  EnrichmentProgressInput,
  RepositoryRelocateReportInput,
  CatalogLearningEvidence,
  CatalogLearningEvidenceKind,
} from "@konteks/backstage-plugin-common";

/**
 * The native preview channel (`preview:<sessionId>`): its chunk shapes, the
 * capability a connector advertises when it can serve previews, the caps and
 * the D125 forwarding policy. The connector enforces the same rules as the
 * relay, on its own hop, rather than trusting the relay did.
 */
export {
  PreviewToRuntimeChunkSchema,
  PreviewToCoreChunkSchema,
  REMOTE_PREVIEW_CAPABILITY,
  advertisesPreview,
  PREVIEW_LIMITS,
  PREVIEW_REQUEST_HEADERS,
  PREVIEW_RESPONSE_HEADERS,
  validatePreviewHeaders,
  sanitizePreviewHeaders,
  validatePreviewPath,
  rewritePreviewLocation,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  PreviewToRuntimeChunk,
  PreviewToCoreChunk,
  PreviewChunk,
  PreviewHeaderRejection,
  PreviewPathRejection,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
