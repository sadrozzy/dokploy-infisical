export interface InfisicalAuth {
  url: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
}

export interface InfisicalSecret {
  id?: string;
  secretKey: string;
  secretValue: string;
  secretPath: string;
  version?: number;
}

interface InfisicalFolder { id: string; name: string }

interface LoginResponse { accessToken: string; expiresIn?: number }

export class InfisicalClient {
  readonly url: string;
  readonly projectId: string;
  readonly environment: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  #accessToken = "";

  constructor(auth: InfisicalAuth) {
    this.url = auth.url.replace(/\/$/, "");
    this.projectId = auth.projectId;
    this.environment = auth.environment;
    this.#clientId = auth.clientId;
    this.#clientSecret = auth.clientSecret;
  }

  async login(): Promise<void> {
    const response = await fetch(new URL("/api/v1/auth/universal-auth/login", this.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.#clientId, clientSecret: this.#clientSecret })
    });
    if (!response.ok) throw new Error(`Infisical authentication returned HTTP ${response.status}`);
    const payload = await response.json() as LoginResponse;
    if (!payload.accessToken) throw new Error("Infisical authentication returned no access token");
    this.#accessToken = payload.accessToken;
  }

  async testConnection(): Promise<void> {
    await this.login();
    await this.listSecrets("/");
  }

  async listSecrets(secretPath: string, recursive = false): Promise<InfisicalSecret[]> {
    const payload = await this.request<{ secrets: InfisicalSecret[] }>("GET", "/api/v4/secrets", undefined, {
      projectId: this.projectId,
      environment: this.environment,
      secretPath,
      recursive: String(recursive)
    });
    return payload.secrets ?? [];
  }

  async getSecret(secretPath: string, secretKey: string): Promise<InfisicalSecret | null> {
    try {
      const payload = await this.request<{ secret: InfisicalSecret }>(
        "GET",
        `/api/v4/secrets/${encodeURIComponent(secretKey)}`,
        undefined,
        { projectId: this.projectId, environment: this.environment, secretPath }
      );
      return payload.secret;
    } catch (error) {
      if (error instanceof InfisicalHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async putSecret(secretPath: string, secretKey: string, secretValue: string, exists: boolean): Promise<void> {
    const payload = await this.request<Record<string, unknown>>(
      exists ? "PATCH" : "POST",
      `/api/v4/secrets/${encodeURIComponent(secretKey)}`,
      { projectId: this.projectId, environment: this.environment, secretPath, secretValue, type: "shared" }
    );
    if (payload.approval) throw new Error(`Infisical approval policy intercepted ${secretPath}:${secretKey}`);
  }

  async deleteSecret(secretPath: string, secretKey: string): Promise<void> {
    try {
      await this.request("DELETE", `/api/v4/secrets/${encodeURIComponent(secretKey)}`, {
        projectId: this.projectId,
        environment: this.environment,
        secretPath,
        type: "shared"
      });
    } catch (error) {
      if (!(error instanceof InfisicalHttpError) || error.status !== 404) throw error;
    }
  }

  async ensureFolder(folderPath: string): Promise<Array<{ id: string; path: string }>> {
    const parts = folderPath.split("/").filter(Boolean);
    let parentPath = "/";
    const created: Array<{ id: string; path: string }> = [];
    for (const folderName of parts) {
      const existing = await this.listFolders(parentPath);
      if (existing.some((folder) => folder.name === folderName)) {
        parentPath = `${parentPath === "/" ? "" : parentPath}/${folderName}`;
        continue;
      }
      try {
        const result = await this.request<{ folder?: { id?: string } }>("POST", "/api/v2/folders", {
          projectId: this.projectId,
          environment: this.environment,
          name: folderName,
          path: parentPath
        });
        const createdPath = `${parentPath === "/" ? "" : parentPath}/${folderName}`;
        if (result.folder?.id) created.push({ id: result.folder.id, path: createdPath });
      } catch (error) {
        const mayBeConcurrentCreate = error instanceof InfisicalHttpError && [400, 409, 422].includes(error.status);
        const nowExists = mayBeConcurrentCreate && (await this.listFolders(parentPath)).some((folder) => folder.name === folderName);
        if (!nowExists) throw error;
      }
      parentPath = `${parentPath === "/" ? "" : parentPath}/${folderName}`;
    }
    return created;
  }

  async listFolders(folderPath: string): Promise<InfisicalFolder[]> {
    const payload = await this.request<{ folders: InfisicalFolder[] }>("GET", "/api/v2/folders", undefined, {
      projectId: this.projectId,
      environment: this.environment,
      path: folderPath,
      recursive: "false"
    });
    return payload.folders ?? [];
  }

  async deleteFolder(folderId: string, parentPath = "/"): Promise<void> {
    try {
      await this.request("DELETE", `/api/v2/folders/${encodeURIComponent(folderId)}`, {
        projectId: this.projectId,
        environment: this.environment,
        path: parentPath,
        forceDelete: false
      });
    } catch (error) {
      if (!(error instanceof InfisicalHttpError) || error.status !== 404) throw error;
    }
  }

  async #ensureToken(): Promise<void> {
    if (!this.#accessToken) await this.login();
  }

  async request<T>(method: string, pathname: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    await this.#ensureToken();
    const url = new URL(pathname, this.url);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const message = await response.text();
      throw new InfisicalHttpError(response.status, `Infisical ${method} ${pathname} returned HTTP ${response.status}${message ? `: ${message.slice(0, 240)}` : ""}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export class InfisicalHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
