import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  LocalSkillSummarySchema,
  RuntimeSkillShareRequestSchema,
  RuntimeSkillSharePublicationResultSchema,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { RemoteInstanceError } from "@konteks/remote-common";
import { confirm, promptLine } from "../prompt.js";
import { outputLocale } from "../setup-locale.js";
import type { ControlContext } from "./control-commands.js";

export interface SkillShareOptions {
  skill: string;
  organization?: boolean;
  systems?: string[];
  initiatives?: string[];
  confirmOngoingPublication?: boolean;
}

function interactive(context: ControlContext): boolean {
  const input = context.input ?? process.stdin;
  return !context.output.json && (input as NodeJS.ReadStream).isTTY === true;
}

async function sharingAudience(context: ControlContext, options: SkillShareOptions) {
  const systems = [...new Set(options.systems ?? [])];
  if (options.organization && systems.length)
    throw new RemoteInstanceError(
      "prerequisite_missing",
      "Choose --organization or --system, never both.",
    );
  if (options.organization) return { kind: "organization" as const };
  if (systems.length) return { kind: "systems" as const, systemRefs: systems };
  if (!interactive(context))
    throw new RemoteInstanceError(
      "prerequisite_missing",
      "Sharing requires --organization or one or more --system values.",
    );
  return promptAudience(context);
}

async function promptAudience(context: ControlContext) {
  const id = outputLocale(context.output) === "id";
  const ask =
    context.promptLine ?? ((label) => promptLine(label, { input: context.input ?? process.stdin }));
  const answer = await ask(
    id
      ? "Cakupan: organization atau ID sistem dipisahkan koma"
      : "Audience: organization or comma-separated system IDs",
  );
  if (answer === "organization") return { kind: "organization" as const };
  return {
    kind: "systems" as const,
    systemRefs: [
      ...new Set(
        answer
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
  };
}

function sourceSelection(skill: string) {
  if (isAbsolute(skill) || skill.startsWith(".") || /[/\\]/.test(skill))
    return { kind: "path" as const, path: resolve(skill) };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(skill))
    throw new RemoteInstanceError("prerequisite_missing", "Choose a Skill name or folder path.");
  return { kind: "name" as const, name: skill };
}

async function sharingConsent(
  context: ControlContext,
  options: SkillShareOptions,
  name: string,
): Promise<void> {
  const id = outputLocale(context.output) === "id";
  const message = id
    ? `Bagikan seluruh folder Skill ${name} dan izinkan publikasi otomatis perubahan berikutnya? Menghapus sumber lokal tidak membatalkan berbagi.`
    : `Share the complete Skill folder ${name} and authorize automatic publication of subsequent edits? Deleting the local source does not unshare it.`;
  if (options.confirmOngoingPublication) return;
  if (!interactive(context))
    throw new RemoteInstanceError(
      "prerequisite_missing",
      "Explicit consent is required: --confirm-ongoing-publication.",
    );
  const ask =
    context.confirm ??
    ((question) =>
      confirm(question, {
        input: context.input ?? process.stdin,
        locale: outputLocale(context.output),
      }));
  if (!(await ask(message)))
    throw new RemoteInstanceError(
      "prerequisite_missing",
      id ? "Berbagi Skill dibatalkan." : "Skill sharing cancelled.",
    );
}

export async function shareSkill(
  context: ControlContext,
  options: SkillShareOptions,
): Promise<void> {
  const audience = await sharingAudience(context, options);
  const initiatives = [...new Set(options.initiatives ?? [])];
  const contextScope = initiatives.length
    ? { kind: "initiatives" as const, initiativeRefs: initiatives }
    : { kind: "global" as const };
  const source = sourceSelection(options.skill);
  const selected = await context.control.call(
    { op: "skills.inspect", source },
    LocalSkillSummarySchema,
    { timeoutMs: 95_000 },
  );
  const selection = RuntimeSkillShareRequestSchema.parse({
    localId: selected.localId,
    treeDigest: selected.treeDigest,
    requestId: randomUUID(),
    audience,
    context: contextScope,
    confirmation: { ongoingPublication: true },
  });
  await sharingConsent(context, options, selected.name);
  const publication = await context.control.call(
    {
      op: "skills.share",
      selection,
      ...(source.kind === "path" ? { sourcePath: source.path } : {}),
    },
    RuntimeSkillSharePublicationResultSchema,
    { timeoutMs: 95_000 },
  );
  context.output.result({ publication, ongoingPublication: "unverified", loaded: "unknown" });
  context.output.line(
    outputLocale(context.output) === "id"
      ? "Publikasi awal diterima. Publikasi berkelanjutan dan pemuatan agen belum terverifikasi."
      : "Initial publication accepted. Ongoing publication and agent loading are not yet verified.",
  );
}
