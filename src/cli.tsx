import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import packageJson from "../package.json" with { type: "json" };
import { loadRuntimeConfig } from "./core/config";
import { DokployClient } from "./core/dokploy";
import { InfisicalClient } from "./core/infisical";
import { rollbackMigration } from "./core/migration";
import { App } from "./tui/App";
import { theme } from "./tui/theme";

const HELP = `dokploy-infisical ${packageJson.version}

Safely sync Dokploy environment secrets with Infisical.

Usage:
  dokploy-infisical
  dokploy-infisical rollback <migration-id>
  dokploy-infisical --help
  dokploy-infisical --version

Commands:
  rollback <migration-id>  Restore and verify an encrypted snapshot

Options:
  -h, --help               Show this help
  -v, --version            Show the installed version`;

async function readHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const fromEnvironment = process.env.DOKPLOY_INFISICAL_RECOVERY_PASSWORD;
    if (fromEnvironment) return fromEnvironment;
    throw new Error("A TTY is required for the recovery password (or set DOKPLOY_INFISICAL_RECOVERY_PASSWORD)");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") { restore(); reject(new Error("Cancelled")); return; }
        if (character === "\r" || character === "\n") { restore(); resolve(value); return; }
        if (character === "\u007f" || character === "\b") {
          if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
        } else if (character >= " ") { value += character; process.stdout.write("•"); }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function runRollback(migrationId: string): Promise<void> {
  if (!migrationId) throw new Error("Usage: dokploy-infisical rollback <migration-id>");
  const runtime = loadRuntimeConfig();
  if (!runtime) throw new Error("Saved credentials are unavailable. Run the TUI setup or provide credential environment variables.");
  const password = await readHidden("Recovery password: ");
  const dokploy = DokployClient.fromCredentials(runtime.dokployUrl, runtime.dokployToken);
  const infisical = new InfisicalClient({
    url: runtime.infisicalUrl,
    clientId: runtime.infisicalClientId,
    clientSecret: runtime.infisicalClientSecret,
    projectId: runtime.infisicalProjectId,
    environment: runtime.infisicalEnvironment
  });
  await rollbackMigration({ dokploy, infisical }, migrationId, password, (progress) => {
    process.stdout.write(`\r${progress.phase}: ${progress.completed}/${progress.total} ${progress.label.slice(0, 80)}   `);
  });
  process.stdout.write(`\nRollback ${migrationId} completed and verified. No redeploy was triggered.\n`);
}

const [command, migrationId, ...extraArguments] = process.argv.slice(2);
if (command === "--help" || command === "-h" || command === "help") {
  console.log(HELP);
  process.exit(0);
}
if (command === "--version" || command === "-v" || command === "version") {
  console.log(packageJson.version);
  process.exit(0);
}
if (command === "rollback") {
  if (extraArguments.length > 0) {
    console.error("Usage: dokploy-infisical rollback <migration-id>");
    process.exit(1);
  }
  try {
    await runRollback(migrationId ?? "");
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (command) {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

const renderer = await createCliRenderer({
  backgroundColor: theme.background,
  clearOnShutdown: true,
  exitOnCtrlC: false,
  openConsoleOnError: false,
  targetFps: 30
});

createRoot(renderer).render(<App />);
