import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const entrypoint = path.resolve(import.meta.dir, "../dist/cli.js");

for (const runtime of ["bun", "node"]) {
  const result = spawnSync(runtime, [entrypoint, "--version"], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== packageJson.version) {
    throw new Error(`${runtime} smoke test failed: ${result.stderr || result.stdout}`);
  }
  console.log(`ok ${runtime}: ${result.stdout.trim()}`);
}
