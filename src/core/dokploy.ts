import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ConnectionInfo, DokployProject } from "./types";

interface DokployAuth {
  token: string;
  url: string;
}

function loadAuth(): DokployAuth {
  const token = process.env.DOKPLOY_API_KEY || process.env.DOKPLOY_AUTH_TOKEN;
  const url = process.env.DOKPLOY_URL;
  if (token && url) return { token, url: url.replace(/\/$/, "") };

  let binary: string;
  try {
    binary = execFileSync("which", ["dokploy"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Dokploy CLI is not installed and DOKPLOY_URL/DOKPLOY_AUTH_TOKEN are not set");
  }

  const realBinary = fs.realpathSync(binary);
  const configPath = path.resolve(path.dirname(realBinary), "..", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { token?: string; url?: string };
  if (!config.url || !config.token) throw new Error("Dokploy CLI config is incomplete; run `dokploy auth`");
  return { token: config.token, url: config.url.replace(/\/$/, "") };
}

export class DokployClient {
  readonly url: string;
  readonly #token: string;

  private constructor(auth: DokployAuth) {
    this.url = auth.url;
    this.#token = auth.token;
  }

  static fromEnvironment(): DokployClient {
    return new DokployClient(loadAuth());
  }

  static fromCredentials(url: string, token: string): DokployClient {
    return new DokployClient({ url: url.replace(/\/$/, ""), token });
  }

  async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`/api/${endpoint}`, this.url);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { "x-api-key": this.#token } });
    if (!response.ok) throw new Error(`Dokploy ${endpoint} returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(new URL(`/api/${endpoint}`, this.url), {
      method: "POST",
      headers: { "x-api-key": this.#token, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Dokploy ${endpoint} returned HTTP ${response.status}${message ? `: ${message.slice(0, 240)}` : ""}`);
    }
    return response.json() as Promise<T>;
  }

  async connectionInfo(): Promise<ConnectionInfo> {
    let version = "connected";
    try {
      version = await this.get<string>("settings.getDokployVersion");
    } catch {
      // Project discovery is the authoritative connection check.
    }
    return { url: this.url, version };
  }

  projects(): Promise<DokployProject[]> {
    return this.get<DokployProject[]>("project.all");
  }
}
