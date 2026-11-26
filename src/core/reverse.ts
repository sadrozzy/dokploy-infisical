import { randomUUID } from "node:crypto";

import type { DokployClient } from "./dokploy";
import { InfisicalClient, InfisicalHttpError, type InfisicalSecret } from "./infisical";
import { isBootstrapService, parseDotenv, slugify } from "./inventory";
import type { MigrationPlan } from "./migration";
import type { DokployProject } from "./types";

interface ServiceDetails {
  env?: string | null;
  buildArgs?: string | null;
  buildSecrets?: string | null;
  createEnvFile?: boolean;
}

export interface ReversePlanSummary {
  plan: MigrationPlan;
  projectRows: Array<{ projectId: string; project: string; additions: number; conflicts: number }>;
  additionCount: number;
  conflictCount: number;
}

async function safeListSecrets(client: InfisicalClient, secretPath: string): Promise<InfisicalSecret[]> {
  try {
    return await client.listSecrets(secretPath);
  } catch (error) {
    if (error instanceof InfisicalHttpError && error.status === 404) return [];
    throw error;
  }
}

function vaultReference(providerName: string, secretPath: string, key: string): string {
  return `\${{vault.${providerName}.${secretPath.replace(/^\//, "")}:${key}}}`;
}

export function appendMissingDotenvValues(source: string, additions: Map<string, string>): string {
  if (additions.size === 0) return source;
  const prefix = source && !source.endsWith("\n") ? `${source}\n` : source;
  return `${prefix}${[...additions].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export async function buildReverseMigrationPlan(
  dokploy: DokployClient,
  infisical: InfisicalClient,
  projects: DokployProject[],
  providerName: string
): Promise<ReversePlanSummary> {
  const dokployWrites: MigrationPlan["dokployWrites"] = [];
  const conflicts: string[] = [];
  const projectRows: ReversePlanSummary["projectRows"] = [];

  for (const project of projects) {
    const projectSlug = slugify(project.name);
    const sharedPath = `/${projectSlug}/_shared`;
    const sharedSecrets = await safeListSecrets(infisical, sharedPath);
    let projectAdditions = 0;
    let projectConflicts = 0;

    for (const environment of project.environments ?? []) {
      for (const application of environment.applications ?? []) {
        if (isBootstrapService(application.name, application.appName ?? "")) continue;
        if (!application.applicationId) continue;
        const details = await dokploy.get<ServiceDetails>("application.one", { applicationId: application.applicationId });
        const servicePath = `/${projectSlug}/${slugify(application.name)}`;
        const serviceSecrets = await safeListSecrets(infisical, servicePath);
        const result = planServiceEnv(details.env ?? "", sharedSecrets, serviceSecrets, providerName, sharedPath, servicePath, `${project.name}/${application.name}`);
        conflicts.push(...result.conflicts);
        projectConflicts += result.conflicts.length;
        projectAdditions += result.additions.size;
        if (result.additions.size) {
          const before = {
            applicationId: application.applicationId,
            env: details.env ?? "",
            buildArgs: details.buildArgs ?? "",
            buildSecrets: details.buildSecrets ?? "",
            createEnvFile: details.createEnvFile ?? false
          };
          dokployWrites.push({ endpoint: "application.saveEnvironment", before, after: { ...before, env: appendMissingDotenvValues(before.env, result.additions) } });
        }
      }
      for (const compose of environment.compose ?? []) {
        if (isBootstrapService(compose.name, compose.appName ?? "")) continue;
        if (!compose.composeId) continue;
        const details = await dokploy.get<ServiceDetails>("compose.one", { composeId: compose.composeId });
        const servicePath = `/${projectSlug}/${slugify(compose.name)}`;
        const serviceSecrets = await safeListSecrets(infisical, servicePath);
        const result = planServiceEnv(details.env ?? "", sharedSecrets, serviceSecrets, providerName, sharedPath, servicePath, `${project.name}/${compose.name}`);
        conflicts.push(...result.conflicts);
        projectConflicts += result.conflicts.length;
        projectAdditions += result.additions.size;
        if (result.additions.size) {
          const before = { composeId: compose.composeId, env: details.env ?? "", createEnvFile: details.createEnvFile ?? false };
          dokployWrites.push({ endpoint: "compose.saveEnvironment", before, after: { ...before, env: appendMissingDotenvValues(before.env, result.additions) } });
        }
      }
    }
    projectRows.push({ projectId: project.projectId, project: project.name, additions: projectAdditions, conflicts: projectConflicts });
  }

  const serviceCount = dokployWrites.length;
  return {
    plan: {
      id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      secretWrites: [],
      dokployWrites,
      direction: "infisical-to-dokploy",
      projects: projects.map((project) => ({ id: project.projectId, name: project.name })),
      serviceCount,
      conflicts
    },
    projectRows,
    additionCount: projectRows.reduce((total, row) => total + row.additions, 0),
    conflictCount: conflicts.length
  };
}

function planServiceEnv(
  env: string,
  sharedSecrets: InfisicalSecret[],
  serviceSecrets: InfisicalSecret[],
  providerName: string,
  sharedPath: string,
  servicePath: string,
  label: string
): { additions: Map<string, string>; conflicts: string[] } {
  const existing = new Map(parseDotenv(env).map((entry) => [entry.key, entry.value]));
  const desired = new Map<string, string>();
  for (const secret of sharedSecrets) desired.set(secret.secretKey, vaultReference(providerName, sharedPath, secret.secretKey));
  for (const secret of serviceSecrets) desired.set(secret.secretKey, vaultReference(providerName, servicePath, secret.secretKey));
  const additions = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [key, reference] of desired) {
    const current = existing.get(key);
    if (current === undefined) additions.set(key, reference);
    else if (!current.includes("${{vault.")) conflicts.push(`${label}:${key}`);
  }
  return { additions, conflicts };
}
