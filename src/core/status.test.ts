import { expect, test } from "bun:test";

import type { DokployClient } from "./dokploy";
import type { InfisicalClient } from "./infisical";
import { inspectSyncStatuses } from "./status";
import type { DokployProject } from "./types";

test("classifies projects as synced, outdated, or not synced", async () => {
  const envById: Record<string, string> = {
    synced: "TOKEN=${{vault.vault-prod.synced/web:TOKEN}}\n",
    outdated: "TOKEN=raw\n",
    empty: ""
  };
  const dokploy = {
    get: async (_endpoint: string, parameters: Record<string, string>) => ({
      env: envById[parameters.applicationId ?? ""] ?? ""
    })
  } as unknown as DokployClient;
  const infisical = {
    listSecrets: async () => [
      { secretKey: "TOKEN", secretValue: "hidden", secretPath: "/synced/web" },
      { secretKey: "TOKEN", secretValue: "hidden", secretPath: "/outdated/web" },
      { secretKey: "TOKEN", secretValue: "hidden", secretPath: "/empty/web" }
    ]
  } as unknown as InfisicalClient;
  const projects: DokployProject[] = ["synced", "outdated", "empty"].map((name) => ({
    projectId: name,
    name,
    environments: [{
      environmentId: "prod",
      name: "prod",
      applications: [{ applicationId: name, name: "web" }],
      compose: []
    }]
  }));

  await expect(inspectSyncStatuses(dokploy, infisical, projects, "vault-prod")).resolves.toEqual({
    synced: "synced",
    outdated: "outdated",
    empty: "not-synced"
  });
});
