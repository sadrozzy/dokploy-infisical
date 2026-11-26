import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DokployClient } from "../core/dokploy";
import type { DokployProject } from "../core/types";
import { App } from "./App";

const projects: DokployProject[] = [
  {
    projectId: "flatby",
    name: "Flatby",
    environments: [{
      environmentId: "production",
      name: "production",
      applications: [{ applicationId: "api", name: "API" }],
      compose: []
    }]
  },
  { projectId: "medbot", name: "MedBot", environments: [] }
];

test("renders projects and supports keyboard selection", async () => {
  const setup = await testRender(
    <App initialData={{
      client: {} as DokployClient,
      connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
      projects
    }} />,
    { width: 100, height: 28 }
  );

  try {
    const initial = await setup.waitForFrame((frame) => frame.includes("Flatby") && frame.includes("MedBot"));
    expect(initial).toContain("selected 0/2");
    await act(async () => {
      setup.mockInput.pressKey(" ");
    });
    const selected = await setup.waitForFrame((frame) => frame.includes("selected 1/2"));
    expect(selected).toContain("◆");
  } finally {
    await act(async () => {
      await setup.dispose();
    });
  }
});

test("shows first-run credential wizard when no config exists", async () => {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App load={async () => null} />, { width: 110, height: 32 });
    await Bun.sleep(0);
  });
  try {
    const frame = await setup.waitForFrame((value) => value.includes("Dokploy URL") && value.includes("Infisical Project ID"));
    expect(frame).toContain("Connect & save");
    expect(frame).toContain("first-run setup");
  } finally {
    await act(async () => { await setup.dispose(); });
  }
});

test("shows the three workflows on a configured cold start", async () => {
  const client = {
    get: async () => ({ env: "" })
  } as unknown as DokployClient;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <App load={async () => ({
        client,
        connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
        projects,
        vaultProviderId: "provider"
      })} />,
      { width: 110, height: 32 }
    );
    await Bun.sleep(0);
  });
  try {
    const frame = await setup.waitForFrame((value) => value.includes("Dokploy → Infisical") && value.includes("Rollback"));
    expect(frame).toContain("Infisical → Dokploy");
    expect(frame).toContain("● Synced");
    expect(frame).toContain("● Outdated");
    expect(frame).toContain("● Not synced");
  } finally {
    await act(async () => { await setup.dispose(); });
  }
});

test("expands services, selects with Enter and continues to review", async () => {
  const setup = await testRender(
    <App
      initialData={{
        client: {} as DokployClient,
        connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
        projects
      }}
      scan={async () => ({
        projects: [{ projectId: "flatby", project: "Flatby", candidates: [], references: [], sources: [], warnings: [] }],
        candidateCount: 0,
        referenceCount: 0,
        warningCount: 0
      })}
    />,
    { width: 100, height: 28 }
  );
  try {
    await act(async () => { setup.mockInput.pressArrow("right"); });
    expect(await setup.waitForFrame((frame) => frame.includes("API") && frame.includes("application"))).toContain("API");
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    expect(await setup.waitForFrame((frame) => frame.includes("selected 1/2"))).toContain("Continue with 1 projects (1 services)");
    await act(async () => { setup.mockInput.pressTab(); await Bun.sleep(0); });
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    expect(await setup.waitForFrame((frame) => frame.includes("Dokploy → Infisical review"))).toContain("Start migration");
  } finally {
    await act(async () => { await setup.dispose(); });
  }
});

test("offers a confirmed redeploy after a verified migration", async () => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-infisical-tui-"));
  const calls: string[] = [];
  const client = {
    url: "https://dokploy.example.com",
    get: async () => ({ env: "", buildArgs: "", buildSecrets: "" }),
    post: async (endpoint: string) => { calls.push(endpoint); return {}; }
  } as unknown as DokployClient;
  const infisical = {
    url: "https://vault.example.com",
    projectId: "project",
    environment: "prod"
  } as unknown as import("../core/infisical").InfisicalClient;
  const setup = await testRender(
    <App
      initialData={{
        client,
        infisical,
        runtime: {
          dokployUrl: "https://dokploy.example.com",
          dokployToken: "hidden",
          infisicalUrl: "https://vault.example.com",
          infisicalClientId: "client",
          infisicalClientSecret: "hidden",
          infisicalProjectId: "project",
          infisicalEnvironment: "prod",
          providerName: "vault-prod"
        },
        connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
        projects
      }}
      scan={async () => ({
        projects: [{ projectId: "flatby", project: "Flatby", candidates: [], references: [], sources: [], warnings: [] }],
        candidateCount: 0,
        referenceCount: 0,
        warningCount: 0
      })}
    />,
    { width: 110, height: 32 }
  );
  try {
    await act(async () => { setup.mockInput.pressArrow("right"); });
    await setup.waitForFrame((frame) => frame.includes("API") && frame.includes("application"));
    await act(async () => { setup.mockInput.pressEnter(); });
    await setup.waitForFrame((frame) => frame.includes("selected 1/2"));
    await act(async () => { setup.mockInput.pressTab(); });
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    await setup.waitForFrame((frame) => frame.includes("Dokploy → Infisical review"));
    await act(async () => { setup.mockInput.pressEnter(); });
    await setup.waitForFrame((frame) => frame.includes("Choose a recovery password"));
    await act(async () => { await setup.mockInput.typeText("long-password"); });
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    expect(await setup.waitForFrame((frame) => frame.includes("Redeploy 1 selected service"))).toContain("Migration applied and verified");
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    expect(await setup.waitForFrame((frame) => frame.includes("Confirm redeploy"))).toContain("Flatby / API");
    await act(async () => { setup.mockInput.pressEnter(); await Bun.sleep(0); });
    expect(await setup.waitForFrame((frame) => frame.includes("1 redeploy requests queued"))).toContain("Migration applied and verified");
    expect(calls).toContain("application.redeploy");
  } finally {
    await act(async () => { await setup.dispose(); });
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }
});
