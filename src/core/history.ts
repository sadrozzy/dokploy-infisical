import fs from "node:fs";
import path from "node:path";

import { migrationDirectory } from "./snapshot";

export interface MigrationHistoryEntry {
  id: string;
  createdAt: string;
  status: "prepared" | "running" | "completed" | "rolled-back" | "rollback-failed" | "legacy";
  direction: "dokploy-to-infisical" | "infisical-to-dokploy" | "legacy";
  projects: Array<{ id: string; name: string }>;
  serviceCount: number;
  secretCount: number;
}

function historyPath(): string {
  return path.join(migrationDirectory(), "index.json");
}

function readIndex(): MigrationHistoryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as MigrationHistoryEntry[] : [];
  } catch {
    return [];
  }
}

export function listMigrationHistory(): MigrationHistoryEntry[] {
  const entries = readIndex().filter((entry) => fs.existsSync(path.join(migrationDirectory(), `${entry.id}.json.enc`)));
  const known = new Set(entries.map((entry) => entry.id));
  try {
    for (const filename of fs.readdirSync(migrationDirectory())) {
      const match = filename.match(/^([A-Za-z0-9_-]+)\.json\.enc$/);
      if (!match || known.has(match[1]!)) continue;
      entries.push({
        id: match[1]!, createdAt: fs.statSync(path.join(migrationDirectory(), filename)).mtime.toISOString(),
        status: "legacy", direction: "legacy", projects: [], serviceCount: 0, secretCount: 0
      });
    }
  } catch {
    // No migration directory yet.
  }
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function upsertMigrationHistory(entry: MigrationHistoryEntry): void {
  const entries = readIndex();
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  fs.mkdirSync(migrationDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(historyPath(), `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(historyPath(), 0o600);
}
