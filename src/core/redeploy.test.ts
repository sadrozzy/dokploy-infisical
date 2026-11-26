import { expect, test } from "bun:test";

import type { DokployClient } from "./dokploy";
import { collectRedeployTargets, queueRedeploys } from "./redeploy";

test("queues explicit redeploys for selected applications and compose services", async () => {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const dokploy = {
    post: async (endpoint: string, body: Record<string, unknown>) => { calls.push({ endpoint, body }); }
  } as unknown as DokployClient;
  const targets = collectRedeployTargets([{
    projectId: "app",
    name: "App",
    environments: [{
      environmentId: "prod",
      name: "prod",
      applications: [
        { applicationId: "web", name: "Web" },
        { applicationId: "vault", name: "Infisical Vault" }
      ],
      compose: [{ composeId: "worker", name: "Worker" }]
    }]
  }]);

  expect(targets.map((target) => target.label)).toEqual(["App / Web", "App / Worker"]);
  await expect(queueRedeploys(dokploy, targets)).resolves.toBe(2);
  expect(calls).toEqual([
    expect.objectContaining({ endpoint: "application.redeploy", body: expect.objectContaining({ applicationId: "web" }) }),
    expect.objectContaining({ endpoint: "compose.redeploy", body: expect.objectContaining({ composeId: "worker" }) })
  ]);
});
