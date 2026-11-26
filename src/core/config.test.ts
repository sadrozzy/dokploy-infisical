import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configPath, saveAppConfig } from "./config";

const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

test("config allow-list never persists credential fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-infisical-config-"));
  process.env.XDG_CONFIG_HOME = directory;
  saveAppConfig({
    dokployUrl: "https://dp.example.com",
    infisicalUrl: "https://vault.example.com",
    infisicalProjectId: "project",
    infisicalEnvironment: "prod",
    providerName: "vault-prod",
    dokployToken: "must-not-leak",
    infisicalClientSecret: "must-not-leak"
  } as Parameters<typeof saveAppConfig>[0]);
  const contents = fs.readFileSync(configPath(), "utf8");
  expect(contents).not.toContain("must-not-leak");
  expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
});
