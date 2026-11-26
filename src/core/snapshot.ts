import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SnapshotEnvelope {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface MigrationSnapshot {
  id: string;
  createdAt: string;
  status: "prepared" | "running" | "completed" | "rolled-back" | "rollback-failed";
  dokployUrl: string;
  infisicalUrl: string;
  infisicalProjectId: string;
  infisicalEnvironment: string;
  dokployWrites: Array<{ endpoint: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  infisicalWrites: Array<{
    secretPath: string;
    secretKey: string;
    before: string | null;
    after: string;
  }>;
  createdFolders?: Array<{ id: string; path: string }>;
  attemptedInfisicalWrites?: number;
  attemptedDokployWrites?: number;
  direction?: "dokploy-to-infisical" | "infisical-to-dokploy";
  projects?: Array<{ id: string; name: string }>;
  serviceCount?: number;
}

export function migrationDirectory(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "dokploy-infisical", "migrations");
}

export function snapshotPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid migration ID");
  return path.join(migrationDirectory(), `${id}.json.enc`);
}

export function encryptSnapshot(snapshot: MigrationSnapshot, password: string): SnapshotEnvelope {
  if (password.length < 10) throw new Error("Recovery password must contain at least 10 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final()]);
  return {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptSnapshot(envelope: SnapshotEnvelope, password: string): MigrationSnapshot {
  if (envelope.version !== 1) throw new Error(`Unsupported snapshot version: ${String(envelope.version)}`);
  const key = scryptSync(password, Buffer.from(envelope.salt, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plaintext) as MigrationSnapshot;
}

export function writeSnapshot(snapshot: MigrationSnapshot, password: string): string {
  const file = snapshotPath(snapshot.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(encryptSnapshot(snapshot, password))}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function readSnapshot(id: string, password: string): MigrationSnapshot {
  const envelope = JSON.parse(fs.readFileSync(snapshotPath(id), "utf8")) as SnapshotEnvelope;
  return decryptSnapshot(envelope, password);
}
