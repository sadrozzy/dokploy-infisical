import { expect, test } from "bun:test";

import type { DokployClient } from "./dokploy";
import type { InfisicalClient } from "./infisical";
import { buildReverseMigrationPlan } from "./reverse";

test("reverse mode attaches shared and service refs without overwriting existing keys", async () => {
  const dokploy = {
    get: async () => ({ env: "EXISTING=raw\nALREADY=${{vault.old.path:ALREADY}}\n", buildArgs: "", buildSecrets: "", createEnvFile: false })
  } as unknown as DokployClient;
  const infisical = {
    listSecrets: async (secretPath: string) => secretPath.endsWith("/_shared")
      ? [
          { secretKey: "SHARED", secretValue: "hidden", secretPath },
          { secretKey: "EXISTING", secretValue: "hidden", secretPath },
          { secretKey: "ALREADY", secretValue: "hidden", secretPath }
        ]
      : [{ secretKey: "SERVICE", secretValue: "hidden", secretPath }]
  } as unknown as InfisicalClient;
  const result = await buildReverseMigrationPlan(dokploy, infisical, [{
    projectId: "app", name: "App", environments: [{
      environmentId: "prod", name: "prod", applications: [{ applicationId: "web", name: "Web" }], compose: []
    }]
  }], "vault-prod");

  expect(result.additionCount).toBe(2);
  expect(result.conflictCount).toBe(1);
  const after = String(result.plan.dokployWrites[0]?.after.env);
  expect(after).toContain("EXISTING=raw");
  expect(after).toContain("ALREADY=${{vault.old.path:ALREADY}}");
  expect(after).toContain("SHARED=${{vault.vault-prod.app/_shared:SHARED}}");
  expect(after).toContain("SERVICE=${{vault.vault-prod.app/web:SERVICE}}");
  expect(after).not.toContain("/services/");
});
