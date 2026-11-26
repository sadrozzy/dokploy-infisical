import { expect, test } from "bun:test";
import { decryptSnapshot, encryptSnapshot, type MigrationSnapshot } from "./snapshot";

test("encrypts rollback snapshots and rejects a wrong password", () => {
  const snapshot: MigrationSnapshot = {
    id: "migration-1", createdAt: new Date(0).toISOString(), status: "prepared",
    dokployUrl: "https://dokploy.example.com", infisicalUrl: "https://vault.example.com",
    infisicalProjectId: "project", infisicalEnvironment: "prod",
    dokployWrites: [], infisicalWrites: [{ secretPath: "/app", secretKey: "TOKEN", before: null, after: "secret" }]
  };
  const envelope = encryptSnapshot(snapshot, "long-password");
  expect(JSON.stringify(envelope)).not.toContain("secret");
  expect(decryptSnapshot(envelope, "long-password")).toEqual(snapshot);
  expect(() => decryptSnapshot(envelope, "wrong-password")).toThrow();
});
