import { coreContractAtLeast, type RemoteWorkKind } from "@konteks/remote-common";
import { REMOTE_DIRECT_MIN_CORE_CONTRACT_VERSION, REMOTE_INTEGRATION_MIN_CORE_CONTRACT_VERSION } from "@konteks/backstage-plugin-common";

// The onboard lane (evidence collector and relocation worker) is always
// composed, so its two kinds are accepted too. Leaving them out meant Core
// never offered a discovery run's evidence work, and grouping evidence was
// never read.
const BASE_KINDS: readonly RemoteWorkKind[] = ["planning", "delivery", "validation", "qa", "assistant_execution", "operations", "search_generation", "onboarding", "repository_relocation"];

/**
 * The work kinds this connector names in a pull. A Core built before a kind
 * refuses a pull naming it, so each later kind is asked for only once Core
 * signs the contract version that introduced it into the desired
 * configuration: `direct` (a person's own chat) from 7.1,
 * `integration` (one bounded integration task)
 * from 7.3. Never inferred from an unrelated field.
 */
export function acceptedWorkKinds(coreContractVersion: string | undefined): RemoteWorkKind[] {
  return [
    ...BASE_KINDS,
    ...(coreContractAtLeast(coreContractVersion, REMOTE_DIRECT_MIN_CORE_CONTRACT_VERSION) ? ["direct" as const] : []),
    ...(coreContractAtLeast(coreContractVersion, REMOTE_INTEGRATION_MIN_CORE_CONTRACT_VERSION) ? ["integration" as const] : []),
  ];
}
