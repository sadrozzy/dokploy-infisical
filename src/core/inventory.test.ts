import { describe, expect, test } from "bun:test";
import type { DokployClient } from "./dokploy";
import {
  destinationPath,
  extractProjectReferences,
  isSecretCandidate,
  parseDotenv,
  resolveProjectExpression,
  scanProjects,
  slugify
} from "./inventory";

describe("inventory", () => {
  test("parses quoted and commented dotenv values", () => {
    expect(parseDotenv('TOKEN="line1\\nline2"\nPORT=3000 # web\n')).toEqual([
      { key: "TOKEN", value: "line1\nline2" },
      { key: "PORT", value: "3000" }
    ]);
  });

  test("detects likely secrets without matching ordinary settings", () => {
    expect(isSecretCandidate("JWT_SECRET", "hidden")).toBe(true);
    expect(isSecretCandidate("DATABASE_URL", "postgres://user:pass@db/app")).toBe(true);
    expect(isSecretCandidate("PORT", "3000")).toBe(false);
    expect(isSecretCandidate("JWT_SECRET", "${{vault.vault-prod.app:JWT_SECRET}}")).toBe(false);
  });

  test("creates stable collision-safe folder paths", () => {
    expect(slugify("APX Flow")).toBe("apx-flow");
    expect(destinationPath("APX Flow", "production", "API Worker", "buildSecrets", "service"))
      .toBe("/apx-flow/api-worker");
    expect(destinationPath("APX Flow", "production", "shared", "env", "project"))
      .toBe("/apx-flow/_shared");
  });

  test("resolves Dokploy project references and rejects cycles", () => {
    const shared = new Map([
      ["BOT_TOKEN", "real-token"],
      ["API_AUTH", "Bearer ${{project.BOT_TOKEN}}"]
    ]);
    expect(extractProjectReferences("${{project.BOT_TOKEN}}")).toEqual(["BOT_TOKEN"]);
    expect(resolveProjectExpression("${{project.API_AUTH}}", shared)).toBe("Bearer real-token");
    expect(() => resolveProjectExpression("${{project.A}}", new Map([
      ["A", "${{project.B}}"],
      ["B", "${{project.A}}"]
    ]))).toThrow("Cyclic project reference");
  });

  test("treats every project-level value as sensitive by default", async () => {
    const client = { get: async () => ({ env: "PUBLIC_URL=${{project.PUBLIC_URL}}" }) } as unknown as DokployClient;
    const report = await scanProjects(client, [{
      projectId: "app",
      name: "App",
      env: "PUBLIC_URL=https://example.com",
      environments: [{
        environmentId: "production",
        name: "production",
        applications: [{ applicationId: "web", name: "web" }],
        compose: []
      }]
    }]);

    expect(report.projects[0]?.candidates).toContainEqual(expect.objectContaining({
      key: "PUBLIC_URL",
      secretPath: "/app/_shared"
    }));
    expect(report.projects[0]?.references[0]?.strategy).toBe("shared-vault");
  });

  test("reuses an existing project Vault ref without copying it into Infisical", async () => {
    const existing = "${{vault.vault-prod.app/_shared:BOT_TOKEN}}";
    const client = { get: async () => ({ env: "BOT_TOKEN=${{project.BOT_TOKEN}}" }) } as unknown as DokployClient;
    const report = await scanProjects(client, [{
      projectId: "app",
      name: "App",
      env: `BOT_TOKEN=${existing}`,
      environments: [{
        environmentId: "production",
        name: "production",
        applications: [{ applicationId: "web", name: "web" }],
        compose: []
      }]
    }]);

    expect(report.projects[0]?.candidates).toHaveLength(0);
    expect(report.projects[0]?.references[0]?.replacementReference).toBe(existing);
  });

  test("stores composite project expressions as one service secret, never an inline Vault ref", async () => {
    const client = { get: async () => ({ env: "PUBLIC_URL=https://${{project.HOST}}/api" }) } as unknown as DokployClient;
    const report = await scanProjects(client, [{
      projectId: "app",
      name: "App",
      env: "HOST=example.com",
      environments: [{
        environmentId: "production",
        name: "production",
        applications: [{ applicationId: "web", name: "web" }],
        compose: []
      }]
    }]);

    const serviceCandidate = report.projects[0]?.candidates.find((candidate) => candidate.key === "PUBLIC_URL");
    const rewrite = report.projects[0]?.references.find((reference) => reference.key === "PUBLIC_URL");
    expect(serviceCandidate).toEqual(expect.objectContaining({
      secretPath: "/app/web",
      value: "https://example.com/api"
    }));
    expect(rewrite?.replacementReference).toBe("${{vault.vault-prod.app/web:PUBLIC_URL}}");
  });
});
