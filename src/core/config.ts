import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  dokployUrl: string;
  infisicalUrl: string;
  infisicalProjectId: string;
  infisicalEnvironment: string;
  providerName: string;
}

export interface Credentials {
  dokployToken: string;
  infisicalClientId: string;
  infisicalClientSecret: string;
}

export interface RuntimeConfig extends AppConfig, Credentials {}

const SERVICE = "dokploy-infisical";
const SECRET_ACCOUNTS = {
  dokployToken: "dokploy-token",
  infisicalClientId: "infisical-client-id",
  infisicalClientSecret: "infisical-client-secret"
} as const;

export function configDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, SERVICE);
}

export function configPath(): string {
  return path.join(configDirectory(), "config.json");
}

export function loadAppConfig(): AppConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<AppConfig>;
    if (!parsed.dokployUrl || !parsed.infisicalUrl || !parsed.infisicalProjectId) return null;
    return {
      dokployUrl: normalizeUrl(parsed.dokployUrl),
      infisicalUrl: normalizeUrl(parsed.infisicalUrl),
      infisicalProjectId: parsed.infisicalProjectId,
      infisicalEnvironment: parsed.infisicalEnvironment || "prod",
      providerName: parsed.providerName || "vault-prod"
    };
  } catch {
    return null;
  }
}

export function saveAppConfig(config: AppConfig): void {
  fs.mkdirSync(configDirectory(), { recursive: true, mode: 0o700 });
  const safeConfig: AppConfig = {
    dokployUrl: config.dokployUrl,
    infisicalUrl: config.infisicalUrl,
    infisicalProjectId: config.infisicalProjectId,
    infisicalEnvironment: config.infisicalEnvironment,
    providerName: config.providerName
  };
  fs.writeFileSync(configPath(), `${JSON.stringify(safeConfig, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath(), 0o600);
}

function keychainAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readKeychain(account: string): string | null {
  if (!keychainAvailable()) return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function writeKeychain(account: string, value: string): void {
  if (!keychainAvailable()) throw new Error("System keychain is unavailable; credentials were not saved");
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value], {
    stdio: "ignore"
  });
}

export function loadCredentials(): Credentials | null {
  const dokployToken = process.env.DOKPLOY_API_KEY || process.env.DOKPLOY_AUTH_TOKEN || readKeychain(SECRET_ACCOUNTS.dokployToken);
  const infisicalClientId = process.env.INFISICAL_CLIENT_ID || readKeychain(SECRET_ACCOUNTS.infisicalClientId);
  const infisicalClientSecret = process.env.INFISICAL_CLIENT_SECRET || readKeychain(SECRET_ACCOUNTS.infisicalClientSecret);
  if (!dokployToken || !infisicalClientId || !infisicalClientSecret) return null;
  return { dokployToken, infisicalClientId, infisicalClientSecret };
}

export function saveCredentials(credentials: Credentials): void {
  writeKeychain(SECRET_ACCOUNTS.dokployToken, credentials.dokployToken);
  writeKeychain(SECRET_ACCOUNTS.infisicalClientId, credentials.infisicalClientId);
  writeKeychain(SECRET_ACCOUNTS.infisicalClientSecret, credentials.infisicalClientSecret);
}

export function loadRuntimeConfig(): RuntimeConfig | null {
  const config = loadAppConfig();
  const credentials = loadCredentials();
  return config && credentials ? { ...config, ...credentials } : null;
}

export function normalizeUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("URL must use http:// or https://");
  return normalized;
}

export function validateRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const normalized = {
    ...config,
    dokployUrl: normalizeUrl(config.dokployUrl),
    infisicalUrl: normalizeUrl(config.infisicalUrl),
    dokployToken: config.dokployToken.trim(),
    infisicalClientId: config.infisicalClientId.trim(),
    infisicalClientSecret: config.infisicalClientSecret.trim(),
    infisicalProjectId: config.infisicalProjectId.trim(),
    infisicalEnvironment: config.infisicalEnvironment.trim() || "prod",
    providerName: config.providerName.trim() || "vault-prod"
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (!value) throw new Error(`${key} is required`);
  }
  return normalized;
}

export function persistRuntimeConfig(config: RuntimeConfig): boolean {
  const validated = validateRuntimeConfig(config);
  saveAppConfig(validated);
  if (!keychainAvailable()) return false;
  saveCredentials(validated);
  return true;
}
