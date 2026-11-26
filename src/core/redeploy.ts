import type { DokployClient } from "./dokploy";
import { isBootstrapService } from "./inventory";
import type { DokployProject } from "./types";

export interface RedeployTarget {
  kind: "application" | "compose";
  id: string;
  label: string;
}

export interface RedeployProgress {
  completed: number;
  total: number;
  label: string;
}

export function collectRedeployTargets(projects: DokployProject[]): RedeployTarget[] {
  const targets = new Map<string, RedeployTarget>();
  for (const project of projects) {
    for (const environment of project.environments ?? []) {
      for (const application of environment.applications ?? []) {
        if (!application.applicationId || isBootstrapService(application.name, application.appName ?? "")) continue;
        const target: RedeployTarget = {
          kind: "application",
          id: application.applicationId,
          label: `${project.name} / ${application.name}`
        };
        targets.set(`${target.kind}:${target.id}`, target);
      }
      for (const compose of environment.compose ?? []) {
        if (!compose.composeId || isBootstrapService(compose.name, compose.appName ?? "")) continue;
        const target: RedeployTarget = {
          kind: "compose",
          id: compose.composeId,
          label: `${project.name} / ${compose.name}`
        };
        targets.set(`${target.kind}:${target.id}`, target);
      }
    }
  }
  return [...targets.values()];
}

export async function queueRedeploys(
  dokploy: DokployClient,
  targets: RedeployTarget[],
  onProgress?: (progress: RedeployProgress) => void
): Promise<number> {
  for (const [index, target] of targets.entries()) {
    onProgress?.({ completed: index, total: targets.length, label: target.label });
    const idField = target.kind === "application" ? "applicationId" : "composeId";
    await dokploy.post(`${target.kind}.redeploy`, {
      [idField]: target.id,
      title: "Secrets synced by dokploy-infisical",
      description: "Explicit redeploy requested after a verified secrets migration"
    });
  }
  onProgress?.({ completed: targets.length, total: targets.length, label: "All redeployments queued" });
  return targets.length;
}
