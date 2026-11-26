import type { DokployClient } from "./dokploy";
import type { InfisicalClient, InfisicalSecret } from "./infisical";
import { isBootstrapService, parseDotenv, slugify } from "./inventory";
import type { DokployProject } from "./types";

export type SyncStatus = "synced" | "outdated" | "not-synced";

interface ServiceDetails { env?: string | null }

export async function inspectSyncStatuses(
  dokploy: DokployClient,
  infisical: InfisicalClient,
  projects: DokployProject[],
  providerName: string
): Promise<Record<string, SyncStatus>> {
  const allSecrets = await infisical.listSecrets("/", true);
  const byPath = new Map<string, InfisicalSecret[]>();
  for (const secret of allSecrets) {
    const list = byPath.get(secret.secretPath) ?? [];
    list.push(secret);
    byPath.set(secret.secretPath, list);
  }
  const statuses: Record<string, SyncStatus> = {};
  for (const project of projects) {
    const projectSlug = slugify(project.name);
    const sharedPath = `/${projectSlug}/_shared`;
    let expected = 0;
    let exact = 0;
    let mismatch = false;
    for (const environment of project.environments ?? []) {
      for (const service of [...(environment.applications ?? []), ...(environment.compose ?? [])]) {
        if (isBootstrapService(service.name, service.appName ?? "")) continue;
        const id = service.applicationId ?? service.composeId;
        if (!id) continue;
        const endpoint = service.applicationId ? "application.one" : "compose.one";
        const parameter: Record<string, string> = service.applicationId ? { applicationId: id } : { composeId: id };
        const details = await dokploy.get<ServiceDetails>(endpoint, parameter);
        const current = new Map(parseDotenv(details.env).map((entry) => [entry.key, entry.value]));
        const servicePath = `/${projectSlug}/${slugify(service.name)}`;
        const desired = new Map<string, string>();
        for (const secret of byPath.get(sharedPath) ?? []) desired.set(secret.secretKey, `\${{vault.${providerName}.${sharedPath.slice(1)}:${secret.secretKey}}}`);
        for (const secret of byPath.get(servicePath) ?? []) desired.set(secret.secretKey, `\${{vault.${providerName}.${servicePath.slice(1)}:${secret.secretKey}}}`);
        expected += desired.size;
        for (const [key, reference] of desired) {
          if (current.get(key) === reference) exact += 1;
          else if (current.has(key)) mismatch = true;
        }
        for (const value of current.values()) {
          if (value.includes("${{vault.") && ![...desired.values()].includes(value)) mismatch = true;
        }
      }
    }
    statuses[project.projectId] = expected > 0 && exact === expected && !mismatch
      ? "synced"
      : exact > 0 || mismatch ? "outdated" : "not-synced";
  }
  return statuses;
}
