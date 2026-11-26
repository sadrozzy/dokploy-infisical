import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DokployClient } from "./dokploy";
import type { InfisicalClient } from "./infisical";
import { buildMigrationPlan, replaceDotenvValues, runMigration, type MigrationPlan } from "./migration";
import type { ScanReport } from "./types";

test("rewrites env blocks without putting secret values into Dokploy", () => {
  expect(replaceDotenvValues("TOKEN=old\nPORT=3000\n", new Map([["TOKEN", "${{vault.prod.app:TOKEN}}"]])))
    .toBe("TOKEN=${{vault.prod.app:TOKEN}}\nPORT=3000\n");

  const report: ScanReport = {
    candidateCount: 1, referenceCount: 1, warningCount: 0,
    projects: [{
      projectId: "p", project: "App", warnings: [],
      candidates: [{ projectId: "p", project: "App", environment: "prod", service: "web", field: "env", key: "TOKEN", secretPath: "/app/web", reference: "${{vault.vault-prod.app/web:TOKEN}}", value: "real", ownerType: "application", ownerId: "web" }],
      references: [{ projectId: "p", project: "App", environment: "prod", service: "web", field: "env", key: "TOKEN", projectKeys: [], strategy: "service-vault", replacementReference: "${{vault.vault-prod.app/web:TOKEN}}", ownerType: "application", ownerId: "web" }],
      sources: [
        { ownerType: "application", ownerId: "web", project: "App", environment: "prod", service: "web", field: "env", value: "TOKEN=real\n" },
        { ownerType: "application", ownerId: "web", project: "App", environment: "prod", service: "web", field: "buildArgs", value: "" },
        { ownerType: "application", ownerId: "web", project: "App", environment: "prod", service: "web", field: "buildSecrets", value: "" }
      ]
    }]
  };
  const plan = buildMigrationPlan(report, "prod-vault");
  expect(plan.dokployWrites[0]?.after.env).toBe("TOKEN=${{vault.prod-vault.app/web:TOKEN}}\n");
  expect(JSON.stringify(plan.dokployWrites[0]?.after)).not.toContain("TOKEN=real");
  expect(replaceDotenvValues(
    "TOKEN=${{vault.existing.app:TOKEN}}\n",
    new Map([["TOKEN", "${{vault.new.app:TOKEN}}"]])
  )).toBe("TOKEN=${{vault.existing.app:TOKEN}}\n");
});

test("automatically restores both systems when cutover fails", async () => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-infisical-migration-"));
  let applicationEnv = "TOKEN=old\n";
  let failCutover = true;
  const secrets = new Map<string, string>();
  const dokploy = {
    url: "https://dp.example.com",
    post: async (_endpoint: string, body: Record<string, unknown>) => {
      if (failCutover && body.env === "TOKEN=${{vault.prod.app:TOKEN}}\n") {
        failCutover = false;
        throw new Error("simulated cutover failure");
      }
      applicationEnv = String(body.env);
      return true;
    },
    get: async () => ({ env: applicationEnv, buildArgs: "", buildSecrets: "" })
  } as unknown as DokployClient;
  const infisical = {
    url: "https://vault.example.com", projectId: "project", environment: "prod",
    getSecret: async (secretPath: string, secretKey: string) => {
      const value = secrets.get(`${secretPath}:${secretKey}`);
      return value === undefined ? null : { secretPath, secretKey, secretValue: value };
    },
    ensureFolder: async () => [],
    putSecret: async (secretPath: string, secretKey: string, value: string) => { secrets.set(`${secretPath}:${secretKey}`, value); },
    deleteSecret: async (secretPath: string, secretKey: string) => { secrets.delete(`${secretPath}:${secretKey}`); },
    deleteFolder: async () => undefined
  } as unknown as InfisicalClient;
  const plan: MigrationPlan = {
    id: "rollback-test", createdAt: new Date(0).toISOString(),
    direction: "dokploy-to-infisical", projects: [{ id: "app", name: "App" }], serviceCount: 1,
    secretWrites: [{ secretPath: "/app", secretKey: "TOKEN", secretValue: "real" }],
    dokployWrites: [{
      endpoint: "application.saveEnvironment",
      before: { applicationId: "web", env: "TOKEN=old\n", buildArgs: "", buildSecrets: "", createEnvFile: false },
      after: { applicationId: "web", env: "TOKEN=${{vault.prod.app:TOKEN}}\n", buildArgs: "", buildSecrets: "", createEnvFile: false }
    }]
  };
  try {
    await expect(runMigration({ dokploy, infisical, dokployUrl: dokploy.url, infisicalUrl: infisical.url, projectId: "project", environment: "prod" }, plan, "long-password"))
      .rejects.toThrow("was rolled back");
    expect(applicationEnv).toBe("TOKEN=old\n");
    expect(secrets.size).toBe(0);
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }
});

test("does not roll back secret writes that never started", async () => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-infisical-folder-failure-"));
  let deleteCalls = 0;
  let dokployCalls = 0;
  const dokploy = {
    url: "https://dp.example.com",
    post: async () => { dokployCalls += 1; },
    get: async () => ({})
  } as unknown as DokployClient;
  const infisical = {
    url: "https://vault.example.com", projectId: "project", environment: "prod",
    getSecret: async () => null,
    ensureFolder: async () => { throw new Error("folder validation failed"); },
    putSecret: async () => undefined,
    deleteSecret: async () => { deleteCalls += 1; },
    deleteFolder: async () => undefined
  } as unknown as InfisicalClient;
  const plan: MigrationPlan = {
    id: "folder-failure", createdAt: new Date(0).toISOString(),
    direction: "dokploy-to-infisical", projects: [{ id: "app", name: "App" }], serviceCount: 0,
    secretWrites: [{ secretPath: "/app", secretKey: "TOKEN", secretValue: "real" }],
    dokployWrites: []
  };
  try {
    await expect(runMigration({ dokploy, infisical, dokployUrl: dokploy.url, infisicalUrl: infisical.url, projectId: "project", environment: "prod" }, plan, "long-password"))
      .rejects.toThrow("was rolled back");
    expect(deleteCalls).toBe(0);
    expect(dokployCalls).toBe(0);
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }
});

test("reports each visible migration stage in order", async () => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-infisical-progress-"));
  let applicationEnv = "TOKEN=raw\n";
  const phases: string[] = [];
  const dokploy = {
    url: "https://dp.example.com",
    post: async (_endpoint: string, body: Record<string, unknown>) => { applicationEnv = String(body.env); },
    get: async () => ({ env: applicationEnv, buildArgs: "", buildSecrets: "" })
  } as unknown as DokployClient;
  const infisical = {
    url: "https://vault.example.com", projectId: "project", environment: "prod",
    ensureFolder: async () => [],
    getSecret: async () => null,
    putSecret: async () => undefined,
    deleteSecret: async () => undefined,
    deleteFolder: async () => undefined
  } as unknown as InfisicalClient;
  const plan: MigrationPlan = {
    id: "progress-test", createdAt: new Date(0).toISOString(),
    direction: "infisical-to-dokploy", projects: [{ id: "app", name: "App" }], serviceCount: 1,
    secretWrites: [],
    dokployWrites: [{
      endpoint: "application.saveEnvironment",
      before: { applicationId: "web", env: "TOKEN=raw\n", buildArgs: "", buildSecrets: "", createEnvFile: false },
      after: { applicationId: "web", env: "TOKEN=${{vault.prod.app:TOKEN}}\n", buildArgs: "", buildSecrets: "", createEnvFile: false }
    }]
  };
  try {
    await runMigration(
      { dokploy, infisical, dokployUrl: dokploy.url, infisicalUrl: infisical.url, projectId: "project", environment: "prod" },
      plan,
      "long-password",
      (progress) => phases.push(progress.phase)
    );
    expect([...new Set(phases)]).toEqual([
      "snapshot", "folders", "secrets", "dokploy", "verify-infisical", "verify-dokploy", "complete"
    ]);
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }
});
