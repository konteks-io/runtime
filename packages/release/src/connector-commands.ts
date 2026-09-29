import { ConnectorCommandsManifestSchema, type ConnectorCommandsManifest } from "@konteks/remote-common";
import table from "./connector-commands.json" with { type: "json" };

/**
 * The `konteks-remote` commands a person runs on a connected computer, with
 * one plain line each and the systems each applies to (runtime-view R20).
 * The table travels inside the connector executable, so what a connector
 * reports is exactly what that release has; the release job also publishes
 * it as `commands.json`. `launcher/src/__tests__/connector-commands.test.ts`
 * checks it against the launcher's real command table.
 */
export const CONNECTOR_COMMANDS_TABLE: { readonly commands: readonly unknown[] } = table;

/**
 * The manifest for one installed release (`version` = its bundle version), or
 * null when the table or the version would not pass the schema: the field is
 * then left out rather than risking a heartbeat.
 */
export function connectorCommandsManifest(version: string, source: { readonly commands: readonly unknown[] } | undefined = CONNECTOR_COMMANDS_TABLE): ConnectorCommandsManifest | null {
  if (!source || !Array.isArray(source.commands)) return null;
  const parsed = ConnectorCommandsManifestSchema.safeParse({ version, commands: source.commands });
  return parsed.success ? parsed.data : null;
}
