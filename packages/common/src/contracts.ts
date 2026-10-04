/**
 * The boundary between the runtime and the shared contract package
 * (`@konteks/backstage-plugin-common`). Every wire type, schema and constant
 * the runtime uses is re-exported here under its shared name, so a rename in
 * the shared package changes only this file.
 *
 * Schemas follow the shared package's `<Name>Schema` convention. Types are
 * the wire names.
 */
export { AcpNativeObservationSchema } from "@konteks/backstage-plugin-common/remote-instance-internal";
export { RuntimeRoleSchema, RemoteWorkKindSchema } from "@konteks/backstage-plugin-common";
export type {
  RuntimePermissionAnswerDeliveryRequest,
  NativeCancellationReceipt,
  NativeCancellationReceiptResult,
  RuntimeCancellationDeliveryRequest,
  RemoteExecutionRevisionControlIntent,
  RemoteExecutionRevisionControlDeliveryRequest,
  NativeExecutionRevisionFenceReceipt,
  NativeExecutionRevisionFenceReceiptRequest,
  NativeExecutionRevisionFenceReceiptResult,
  RemoteExecutionOperationDisposition,
  RemoteExecutionAuthorityView,
  RemoteExecutionOperationPermitClaims,
  RemoteExecutionAdmissionClaims,
  RemoteExecutionConsumeRequest,
  RemoteExecutionCheckRequest,
  RemoteAuthorizedOperation,
  RemoteExecutionReadyRequest,
  RemoteExecutionReadyResult,
  RemoteAssignmentInputsEnvelope,
  RemoteFileEntry,
  RemoteFileTree,
  RemoteDeliveryResultCandidate,
  RemoteDeliveryAcceptanceReceipt,
  RemoteTransferBinding,
  RemoteTransferManifest,
  RemoteSkillCatalog,
  // State model and projections
  RemoteWorkKind,
  RuntimeRole,
  OwnershipScope,
  ConnectedAgentView,
  RuntimeUtilization,
  RemoteInstanceView,
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
  // Reconnect and recovery
  RemoteRuntimeOwnerResolveResult,
  RemoteReconciliationConnection,
  RemoteReconciliationAppliedRequest,
  RemoteReconciliationAppliedResult,
  RemoteRecoveryEvidence,
  RemoteReconciliationDecisionResult,
  RemoteReconnectIntentSnapshot,
  RemoteInstanceReconnectRequest,
  RecoveryDecision,
  RemoteInstanceReconciliationManifest,
  // Relay transport
  RelayChannel,
  ToCoreRelayFrame,
  ToRuntimeRelayFrame,
  RelayAck,
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
  ClaimResult,
  BoundedJsonValue,
  AssignmentReport,
  ReportAck,
  CancelDirective,
  SupportChunk,
  AcpJsonRpcError,
  SessionToCoreMessage,
  SessionToRuntimeMessage,
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
  // Permissions
  PendingPermissionView,
  PlanningControllerTerminalDirective,
  PlanningControllerDirectivePullRequest,
  PlanningControllerDirectivePullResult,
  // Economics
  AgentTurnUsageObservation,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// Logical assignment identities. Authentication and accepting owners remain separate.
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
  // A coding agent login the person starts on this machine from the site.
  REMOTE_AGENT_LOGIN_CAPABILITY,
  REMOTE_AGENT_LOGIN_BROWSER_CAPABILITY,
  RuntimeAgentLoginDeliveryRequestSchema,
  type RuntimeAgentLoginDeliveryRequest,
  RuntimeAgentLoginReportSchema,
  AgentLoginUserCodeSchema,
  agentLoginUrlAllowed,
  // OpenCode's sign-ins the site may start.
  REMOTE_AGENT_LOGIN_OPENCODE_CAPABILITY,
  OPENCODE_LOGIN_OPTIONS,
  OPENCODE_LOGIN_OPTION_IDS,
  OpenCodeLoginOptionIdSchema,
  type OpenCodeLoginOptionId,
  type OpenCodeLoginOption,
  openCodeLoginOptionCapability,
  OpenCodeLoginUserCodeSchema,
  agentLoginMethod,
  // Google Antigravity's sign-ins: Gemini Enterprise from the site with its
  // Google Cloud project; any agent's option.
  REMOTE_AGENT_LOGIN_ANTIGRAVITY_CAPABILITY,
  ANTIGRAVITY_LOGIN_OPTIONS,
  type AntigravityLoginOptionId,
  antigravityLoginOptionCapability,
  AgentLoginOptionIdSchema,
  type AgentLoginOptionId,
  AgentLoginGcpSchema,
  type AgentLoginGcp,
  GoogleCloudProjectIdSchema,
  GeminiEnterpriseLocationSchema,
  GEMINI_ENTERPRISE_LOCATIONS,
  type AgentLoginFailure,
  // A step the connector brings to the front on the computer for a site-started action.
  REMOTE_AGENT_LOGIN_ON_COMPUTER_CAPABILITY,
  ON_COMPUTER_LOGIN_OPTION,
  type OnComputerStep,
  // A connected agent's credentials and the money basis of a turn.
  ConnectedAgentCredentialSchema,
  type ConnectedAgentCredential,
  MAX_CONNECTED_AGENT_CREDENTIALS,
  // A fetched host agent's download state.
  HostAgentDownloadSchema,
  type HostAgentDownload,
  remoteMoneyBasisFor,
  type RemoteMoneyBasis,
  REMOTE_OPENCODE_FREE_MODELS_CAPABILITY,
  // The Core wire-contract version signed into the desired configuration:
  // this build reads `coreContractVersion` and advertises the capability that
  // asks Core for it.
  REMOTE_CORE_CONTRACT_CAPABILITY,
  coreContractAtLeast,
  RemoteExecutionRevisionControlIntentSchema,
  computeExecutionRevisionControlIntentDigest,
  RemoteExecutionRevisionControlDeliveryRequestSchema,
  executionRevisionControlSigningBytes,
  NativeExecutionRevisionFenceReceiptSchema,
  NativeExecutionRevisionFenceReceiptRequestSchema,
  NativeExecutionRevisionFenceReceiptResultSchema,
  RemoteExecutionAuthorityViewSchema,
  RemoteExecutionAdmissionClaimsSchema,
  RemoteExecutionConsumeRequestSchema,
  RemoteExecutionConsumeResultSchema,
  RemoteExecutionCheckRequestSchema,
  RemoteExecutionCheckResultSchema,
  RemoteAuthorizedOperationSchema,
  verifyRemoteExecutionOperationSignature,
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

// Pending claim recovery inventory. Parsing proves local relations only:
// Core authority, coverage and pre-execution qualification remain owner checks.
export {
  PendingClaimRequestSchema, derivePendingClaimReference,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  PendingClaimRequest,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// Correlated transport replies. Acceptance of an envelope is not domain proof.
export {
  AssignmentTransportReplySchema, AssignmentResponseReferenceSchema,
  AssignmentRequestKindSchema, logicalAssignmentResponseDigest,
  LogicalAssignmentReplyFrameSchema, AssignmentReplyFrameSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  AssignmentTransportReply,
  AssignmentReplyFrame,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

// The native HTTPS carrier. Establishing native's own authority, never a relay's.
export {
  NativeAssignmentRequestSchema, NativeAssignmentResultSchema,
  NativeAssignmentAckRequestSchema, NativeAssignmentAckResultSchema,
  NativeCoreRequestAckSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  NativeAssignmentResult,
  NativeAssignmentAckResult,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

export {
  RemoteExecutionReadyRequestSchema,
  RemoteExecutionReadyResultSchema,
  RemoteAssignmentInputsEnvelopeSchema,
  RemoteAssignmentInputsPrepareRequestSchema,
  RemoteAssignmentInputsReadRequestSchema,
  RemoteRepositoryFetchRequestSchema,
  computeRemoteAssignmentInputSelectionDigest,
  computeRemoteSkillCatalogDigest,
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
  computeRemoteReconciliationManifestDigest,
  computeRemoteReconciliationReceiptDigest,
  computeRemoteReconnectSnapshotDigest,
  computeRemoteReconciliationReceiptSnapshotDigest,
  ToRuntimeRelayFrameSchema,
  ToCoreRelayFrameSchema,
  RelayAckSchema,
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
  // The instance-proof audience, shared so neither Core nor the supervisor
  // derives it on its own.
  REMOTE_INSTANCE_PROOF_AUDIENCE,
  DiagnosticCarrierCompanionSchema,
  DiagnosticCarrierCompanionDeliveryRequestSchema,
  diagnosticCarrierCompanionSigningBytes,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  DiagnosticCarrierCompanion,
  DiagnosticCarrierCompanionDeliveryRequest,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

/**
 * Wire constants the shared package owns (platforms, protocol version, lease
 * audience), so the runtime never hard-codes a value the control plane also
 * owns.
 */
export {
  RemotePlatformSchema,
  REMOTE_INSTANCE_PROTOCOL_VERSION,
  REMOTE_LEASE_AUDIENCE as REMOTE_INSTANCE_LEASE_AUDIENCE,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

/**
 * Onboarding. The `onboard` role reads repositories and moves them, so the
 * runtime needs the discovery-run vocabulary, the evidence submission shape it
 * is allowed to send (deliberately WITHOUT `collectedBy`, which Core stamps),
 * and the relocation tool names.
 */
export {
  DiscoveryDepthSchema,
  DiscoveryRunBoundsSchema,
  DiscoveryInventoryItemSchema,
  DiscoveryEvidenceFactsSchema,
  DiscoveryEvidenceSubmissionSchema,
  EnrichmentProgressInputSchema,
  REPOSITORY_RELOCATE_REPORT_TOOL,
  REPOSITORY_RELOCATE_STATUS_TOOL,
} from "@konteks/backstage-plugin-common";
export type {
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
 * the header and path forwarding policy. The connector enforces the same rules as the
 * relay, on its own hop, rather than trusting the relay did.
 */
export {
  PreviewToRuntimeChunkSchema,
  REMOTE_PREVIEW_CAPABILITY,
  advertisesPreview,
  PREVIEW_LIMITS,
  validatePreviewHeaders,
  sanitizePreviewHeaders,
  validatePreviewPath,
  rewritePreviewLocation,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
export type {
  PreviewToRuntimeChunk,
  PreviewToCoreChunk,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

/**
 * The runtime view: the `direct` work kind a person's own chat on this
 * computer arrives as, the slash commands each agent announced here, the real
 * state of every supported agent, and the connector commands manifest shipped
 * with the release.
 */
export {
  isDirectWorkKind,
  AvailableCommandListSchema,
  normalizeAvailableCommands,
  SupportedAgentEntrySchema,
  SupportedAgentListSchema,
  ConnectorCommandsManifestSchema,
  connectorCommandsFor,
} from "@konteks/backstage-plugin-common";
export type {
  AvailableCommand,
  RawAvailableCommand,
  SupportedAgentState,
  SupportedAgentEntry,
  ConnectorCommandsManifest,
} from "@konteks/backstage-plugin-common";
