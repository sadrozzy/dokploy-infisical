import { afterEach, expect, test } from "bun:test";

import { InfisicalClient } from "./infisical";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses the live Infisical folder and DELETE request schemas", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    requests.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/api/v1/auth/universal-auth/login")) {
      return Response.json({ accessToken: "access" });
    }
    if (url.includes("/api/v2/folders?") && (init?.method ?? "GET") === "GET") {
      return Response.json({ folders: [] });
    }
    if (url.endsWith("/api/v2/folders") && init?.method === "POST") {
      return Response.json({ folder: { id: "folder-id" } });
    }
    return Response.json({ secret: {} });
  }) as typeof fetch;

  const client = new InfisicalClient({
    url: "https://vault.example.com",
    clientId: "client",
    clientSecret: "secret",
    projectId: "project",
    environment: "prod"
  });
  await client.ensureFolder("/app");
  await client.deleteSecret("/app", "TOKEN");
  await client.deleteFolder("folder-id");

  expect(requests[1]?.method).toBe("GET");
  expect(requests[2]?.body).toEqual({ projectId: "project", environment: "prod", name: "app", path: "/" });
  expect(requests[3]?.method).toBe("DELETE");
  expect(requests[3]?.body).toEqual({ projectId: "project", environment: "prod", secretPath: "/app", type: "shared" });
  expect(requests[4]?.body).toEqual({ projectId: "project", environment: "prod", path: "/", forceDelete: false });
});
