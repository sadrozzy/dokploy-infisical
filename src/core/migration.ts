import { randomUUID } from "node:crypto";

import { DokployClient } from "./dokploy";
import { InfisicalClient } from "./infisical";
import { upsertMigrationHistory } from "./history";
import { parseDotenv } from "./inventory";
import { readSnapshot, writeSnapshot, type MigrationSnapshot } from "./snapshot";
import type { EnvironmentSource, ScanReport } from "./types";

export interface MigrationPlan {
  id: string;
  createdAt: string;
  secretWrites: Array<{ secretPath: string; secretKey: string; secretValue: string }>;
  dokployWrites: Array<{ endpoint: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  direction: "dokploy-to-infisical" | "infisical-to-dokploy";
  projects: Array<{ id: string; name: string }>;
  serviceCount: number;
  conflicts?: string[];
}

export interface MigrationProgress {
  phase: "snapshot" | "folders" | "secrets" | "dokploy" | "verify-infisical" | "verify-dokploy" | "rollback" | "complete";
  completed: number;
  total: number;
  label: string;
}

interface MigrationContext {
  dokploy: DokployClient;
  infisical: InfisicalClient;
  dokployUrl: string;
  infisicalUrl: string;
  projectId: string;
  environment: string;
}

function providerReference(reference: string, providerName: string): string {
  return reference.replace(/\$\{\{vault\.vault-prod\./g, `\${{vault.${providerName}.`);
}

function encodeEnvValue(value: string): string {
  if (!value) return "";
  if (/^[^\s#'"\\]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function replaceDotenvValues(source: string, replacements: Map<string, string>): string {
  const entries = parseDotenv(source);
  if (entries.length === 0) return source;
  return `${entries.map(({ key, value }) => {
    const replacement = value.includes("${{vault.") ? value : replacements.get(key) ?? value;
    return `${key}=${encodeEnvValue(replacement)}`;
  }).join("\n")}\n`;
}

function sourceKey(source: Pick<EnvironmentSource, "ownerType" | "ownerId">): string {
  return `${source.ownerType}:${source.ownerId}`;
}

export function buildMigrationPlan(report: ScanReport, providerName: string): MigrationPlan {
  const secretMap = new Map<string, { secretPath: string; secretKey: string; secretValue: string }>();
  const sourceMap = new Map<string, EnvironmentSource[]>();
  const replacementMap = new Map<string, Map<string, string>>();

  for (const project of report.projects) {
    for (const candidate of project.candidates) {
      secretMap.set(`${candidate.secretPath}\0${candidate.key}`, {
        secretPath: candidate.secretPath,
        secretKey: candidate.key,
        secretValue: candidate.value
      });
    }
    for (const source of project.sources) {
      const key = sourceKey(source);
      const list = sourceMap.get(key) ?? [];
      list.push(source);
      sourceMap.set(key, list);
    }
    for (const reference of project.references) {
      const key = `${reference.ownerType}:${reference.ownerId}:${reference.field}`;
      const replacements = replacementMap.get(key) ?? new Map<string, string>();
      replacements.set(reference.key, providerReference(reference.replacementReference, providerName));
      replacementMap.set(key, replacements);
    }
  }

  const dokployWrites: MigrationPlan["dokployWrites"] = [];
  for (const [ownerKey, sources] of sourceMap) {
    const [ownerType, ownerId] = ownerKey.split(":") as [EnvironmentSource["ownerType"], string];
    if (ownerType === "project") continue;
    const changed = sources.some((source) => replacementMap.has(`${ownerKey}:${source.field}`));
    if (!changed) continue;

    if (ownerType === "application") {
      const before = {
        applicationId: ownerId,
        env: sources.find((source) => source.field === "env")?.value ?? "",
        buildArgs: sources.find((source) => source.field === "buildArgs")?.value ?? "",
        buildSecrets: sources.find((source) => source.field === "buildSecrets")?.value ?? "",
        createEnvFile: sources.find((source) => source.createEnvFile !== undefined)?.createEnvFile ?? false
      };
      const after = { ...before };
      for (const field of ["env", "buildArgs", "buildSecrets"] as const) {
        const replacements = replacementMap.get(`${ownerKey}:${field}`);
        if (replacements) after[field] = replaceDotenvValues(before[field], replacements);
      }
      dokployWrites.push({ endpoint: "application.saveEnvironment", before, after });
      continue;
    }

    const source = sources.find((item) => item.field === "env");
    if (!source) continue;
    const replacements = replacementMap.get(`${ownerKey}:env`);
    if (!replacements) continue;
    const env = replaceDotenvValues(source.value, replacements);
    if (ownerType === "compose") {
      const before = { composeId: ownerId, env: source.value, createEnvFile: source.createEnvFile ?? false };
      dokployWrites.push({ endpoint: "compose.saveEnvironment", before, after: { ...before, env } });
    } else {
      const before = { environmentId: ownerId, env: source.value };
      dokployWrites.push({ endpoint: "environment.update", before, after: { ...before, env } });
    }
  }

  return {
    id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    secretWrites: [...secretMap.values()],
    dokployWrites,
    direction: "dokploy-to-infisical",
    projects: report.projects.map((project) => ({ id: project.projectId, name: project.project })),
    serviceCount: new Set(report.projects.flatMap((project) => project.sources
      .filter((source) => source.ownerType === "application" || source.ownerType === "compose")
      .map((source) => `${source.ownerType}:${source.ownerId}`))).size
  };
}

async function prepareSnapshot(
  context: MigrationContext,
  plan: MigrationPlan,
  onProgress?: (progress: MigrationProgress) => void
): Promise<MigrationSnapshot> {
  const infisicalWrites: MigrationSnapshot["infisicalWrites"] = [];
  const total = plan.secretWrites.length + 1;
  for (const [index, write] of plan.secretWrites.entries()) {
    onProgress?.({
      phase: "snapshot",
      completed: index,
      total,
      label: `Reading previous value ${write.secretPath}:${write.secretKey}`
    });
    const existing = await context.infisical.getSecret(write.secretPath, write.secretKey);
    infisicalWrites.push({
      secretPath: write.secretPath,
      secretKey: write.secretKey,
      before: existing?.secretValue ?? null,
      after: write.secretValue
    });
  }
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    status: "prepared",
    dokployUrl: context.dokployUrl,
    infisicalUrl: context.infisicalUrl,
    infisicalProjectId: context.projectId,
    infisicalEnvironment: context.environment,
    dokployWrites: plan.dokployWrites,
    infisicalWrites,
    createdFolders: [],
    attemptedInfisicalWrites: 0,
    attemptedDokployWrites: 0,
    direction: plan.direction,
    projects: plan.projects,
    serviceCount: plan.serviceCount
  };
}

function historyEntry(snapshot: MigrationSnapshot) {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    direction: snapshot.direction ?? "legacy" as const,
    projects: snapshot.projects ?? [],
    serviceCount: snapshot.serviceCount ?? 0,
    secretCount: snapshot.infisicalWrites.length
  };
}

async function verifyDokployWrite(dokploy: DokployClient, write: MigrationPlan["dokployWrites"][number]): Promise<void> {
  const expected = write.after;
  if (write.endpoint === "application.saveEnvironment") {
    const actual = await dokploy.get<Record<string, unknown>>("application.one", { applicationId: String(expected.applicationId) });
    for (const field of ["env", "buildArgs", "buildSecrets"] as const) {
      if (actual[field] !== expected[field]) throw new Error(`Dokploy verification failed for application ${String(expected.applicationId)} ${field}`);
    }
  } else if (write.endpoint === "compose.saveEnvironment") {
    const actual = await dokploy.get<Record<string, unknown>>("compose.one", { composeId: String(expected.composeId) });
    if (actual.env !== expected.env) throw new Error(`Dokploy verification failed for compose ${String(expected.composeId)}`);
  } else {
    const actual = await dokploy.get<Record<string, unknown>>("environment.one", { environmentId: String(expected.environmentId) });
    if (actual.env !== expected.env) throw new Error(`Dokploy verification failed for environment ${String(expected.environmentId)}`);
  }
}

export async function rollbackSnapshot(
  context: Pick<MigrationContext, "dokploy" | "infisical">,
  snapshot: MigrationSnapshot,
  onProgress?: (progress: MigrationProgress) => void
): Promise<void> {
  const dokployWrites = snapshot.attemptedDokployWrites === undefined
    ? snapshot.dokployWrites
    : snapshot.dokployWrites.slice(0, snapshot.attemptedDokployWrites);
  const infisicalWrites = snapshot.attemptedInfisicalWrites === undefined
    ? snapshot.infisicalWrites
    : snapshot.infisicalWrites.slice(0, snapshot.attemptedInfisicalWrites);
  const total = dokployWrites.length + infisicalWrites.length + (snapshot.createdFolders?.length ?? 0);
  let completed = 0;
  for (const write of [...dokployWrites].reverse()) {
    onProgress?.({ phase: "rollback", completed, total, label: `Restore ${write.endpoint}` });
    await context.dokploy.post(write.endpoint, write.before);
    await verifyDokployWrite(context.dokploy, { ...write, after: write.before });
    completed += 1;
  }
  for (const write of [...infisicalWrites].reverse()) {
    onProgress?.({ phase: "rollback", completed, total, label: `Restore ${write.secretPath}:${write.secretKey}` });
    if (write.before === null) await context.infisical.deleteSecret(write.secretPath, write.secretKey);
    else await context.infisical.putSecret(write.secretPath, write.secretKey, write.before, true);
    const restored = await context.infisical.getSecret(write.secretPath, write.secretKey);
    if (write.before === null ? restored !== null : restored?.secretValue !== write.before) {
      throw new Error(`Rollback verification failed for ${write.secretPath}:${write.secretKey}`);
    }
    completed += 1;
  }
  for (const folder of [...(snapshot.createdFolders ?? [])].reverse()) {
    onProgress?.({ phase: "rollback", completed, total, label: `Remove empty folder ${folder.path}` });
    const parentPath = folder.path.split("/").slice(0, -1).join("/") || "/";
    await context.infisical.deleteFolder(folder.id, parentPath);
    completed += 1;
  }
  onProgress?.({ phase: "rollback", completed: total, total, label: "Rollback restored and verified" });
}

export async function runMigration(
  context: MigrationContext,
  plan: MigrationPlan,
  recoveryPassword: string,
  onProgress?: (progress: MigrationProgress) => void
): Promise<MigrationSnapshot> {
  const snapshot = await prepareSnapshot(context, plan, onProgress);
  writeSnapshot(snapshot, recoveryPassword);
  upsertMigrationHistory(historyEntry(snapshot));
  onProgress?.({
    phase: "snapshot",
    completed: plan.secretWrites.length + 1,
    total: plan.secretWrites.length + 1,
    label: "Encrypted rollback snapshot saved"
  });
  snapshot.status = "running";
  writeSnapshot(snapshot, recoveryPassword);
  upsertMigrationHistory(historyEntry(snapshot));

  try {
    const folders = [...new Set(plan.secretWrites.map((write) => write.secretPath))];
    onProgress?.({ phase: "folders", completed: 0, total: folders.length, label: folders.length ? "Preparing Infisical folders" : "No folders required" });
    for (const [index, folder] of folders.entries()) {
      onProgress?.({ phase: "folders", completed: index, total: folders.length, label: folder });
      const created = await context.infisical.ensureFolder(folder);
      snapshot.createdFolders?.push(...created);
      writeSnapshot(snapshot, recoveryPassword);
    }
    onProgress?.({ phase: "secrets", completed: 0, total: snapshot.infisicalWrites.length, label: snapshot.infisicalWrites.length ? "Writing secrets to Infisical" : "No Infisical secret writes required" });
    for (const [index, write] of snapshot.infisicalWrites.entries()) {
      onProgress?.({ phase: "secrets", completed: index, total: snapshot.infisicalWrites.length, label: `${write.secretPath}:${write.secretKey}` });
      snapshot.attemptedInfisicalWrites = index + 1;
      writeSnapshot(snapshot, recoveryPassword);
      await context.infisical.putSecret(write.secretPath, write.secretKey, write.after, write.before !== null);
    }
    onProgress?.({ phase: "dokploy", completed: 0, total: plan.dokployWrites.length, label: plan.dokployWrites.length ? "Updating Dokploy Vault references" : "No Dokploy updates required" });
    for (const [index, write] of plan.dokployWrites.entries()) {
      onProgress?.({ phase: "dokploy", completed: index, total: plan.dokployWrites.length, label: write.endpoint });
      snapshot.attemptedDokployWrites = index + 1;
      writeSnapshot(snapshot, recoveryPassword);
      await context.dokploy.post(write.endpoint, write.after);
    }
    onProgress?.({ phase: "verify-infisical", completed: 0, total: snapshot.infisicalWrites.length, label: snapshot.infisicalWrites.length ? "Verifying Infisical values" : "No Infisical writes to verify" });
    for (const [index, write] of snapshot.infisicalWrites.entries()) {
      onProgress?.({ phase: "verify-infisical", completed: index, total: snapshot.infisicalWrites.length, label: `${write.secretPath}:${write.secretKey}` });
      const actual = await context.infisical.getSecret(write.secretPath, write.secretKey);
      if (actual?.secretValue !== write.after) throw new Error(`Infisical verification failed for ${write.secretPath}:${write.secretKey}`);
    }
    onProgress?.({ phase: "verify-dokploy", completed: 0, total: plan.dokployWrites.length, label: plan.dokployWrites.length ? "Verifying Dokploy references" : "No Dokploy writes to verify" });
    for (const [index, write] of plan.dokployWrites.entries()) {
      onProgress?.({ phase: "verify-dokploy", completed: index, total: plan.dokployWrites.length, label: write.endpoint });
      await verifyDokployWrite(context.dokploy, write);
    }
    snapshot.status = "completed";
    writeSnapshot(snapshot, recoveryPassword);
    upsertMigrationHistory(historyEntry(snapshot));
    onProgress?.({ phase: "complete", completed: 1, total: 1, label: snapshot.id });
    return snapshot;
  } catch (error) {
    try {
      await rollbackSnapshot(context, snapshot, onProgress);
      snapshot.status = "rolled-back";
    } catch (rollbackError) {
      snapshot.status = "rollback-failed";
      writeSnapshot(snapshot, recoveryPassword);
      upsertMigrationHistory(historyEntry(snapshot));
      throw new Error(`Migration failed: ${error instanceof Error ? error.message : String(error)}. Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    writeSnapshot(snapshot, recoveryPassword);
    upsertMigrationHistory(historyEntry(snapshot));
    throw new Error(`Migration failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function rollbackMigration(
  context: Pick<MigrationContext, "dokploy" | "infisical">,
  migrationId: string,
  recoveryPassword: string,
  onProgress?: (progress: MigrationProgress) => void
): Promise<MigrationSnapshot> {
  const snapshot = readSnapshot(migrationId, recoveryPassword);
  if (snapshot.dokployUrl !== context.dokploy.url) throw new Error("Rollback snapshot belongs to a different Dokploy instance");
  if (snapshot.infisicalUrl.replace(/\/$/, "") !== context.infisical.url) throw new Error("Rollback snapshot belongs to a different Infisical instance");
  if (snapshot.infisicalProjectId !== context.infisical.projectId || snapshot.infisicalEnvironment !== context.infisical.environment) {
    throw new Error("Rollback snapshot belongs to a different Infisical project or environment");
  }
  await rollbackSnapshot(context, snapshot, onProgress);
  snapshot.status = "rolled-back";
  writeSnapshot(snapshot, recoveryPassword);
  upsertMigrationHistory(historyEntry(snapshot));
  return snapshot;
}
