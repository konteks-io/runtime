import type { IntegrationSetupResult, IntegrationSetupTaskSpec } from "@konteks/backstage-plugin-common";

/** Runs one confirmed official setup operation (P08, D29). */
export interface IntegrationSetupRunner {
  run(spec: IntegrationSetupTaskSpec, assertCurrent: () => void): Promise<IntegrationSetupResult>;
}
