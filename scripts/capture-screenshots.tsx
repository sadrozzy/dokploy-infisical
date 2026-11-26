import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import fs from "node:fs";
import path from "node:path";

import type { DokployClient } from "../src/core/dokploy";
import type { DokployProject } from "../src/core/types";
import { App } from "../src/tui/App";

const projects: DokployProject[] = [
  {
    projectId: "commerce",
    name: "Commerce",
    environments: [{
      environmentId: "production",
      name: "production",
      applications: [
        { applicationId: "api", name: "API" },
        { applicationId: "worker", name: "Worker" }
      ],
      compose: [{ composeId: "monitoring", name: "Monitoring" }]
    }]
  },
  {
    projectId: "website",
    name: "Website",
    environments: [{
      environmentId: "production",
      name: "production",
      applications: [{ applicationId: "frontend", name: "Frontend" }],
      compose: []
    }]
  }
];

const client = {
  get: async () => ({ env: "" })
} as unknown as DokployClient;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function frameToSvg(frame: string, label: string): string {
  const lines = frame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n");
  const columns = Math.max(...lines.map((line) => [...line].length), 1);
  const width = Math.max(960, columns * 9 + 40);
  const height = lines.length * 19 + 70;
  const rows = lines.map((line, index) =>
    `<text x="20" y="${58 + index * 19}" class="row">${escapeXml(line || " ")}</text>`
  ).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">
  <rect width="100%" height="100%" rx="14" fill="#080c12"/>
  <circle cx="22" cy="22" r="6" fill="#ff5f57"/><circle cx="42" cy="22" r="6" fill="#febc2e"/><circle cx="62" cy="22" r="6" fill="#28c840"/>
  <text x="50%" y="27" text-anchor="middle" class="title">dokploy-infisical</text>
  <style>
    .title { fill: #7f8da3; font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .row { fill: #d8e1ee; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  </style>
  ${rows}
</svg>\n`;
}

async function capture(): Promise<void> {
  const outputDirectory = path.resolve(import.meta.dir, "../docs/screenshots");
  fs.mkdirSync(outputDirectory, { recursive: true });

  let workflows!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    workflows = await testRender(
      <App load={async () => ({
        client,
        connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
        projects,
        vaultProviderId: "provider"
      })} />,
      { width: 110, height: 32 }
    );
    await Bun.sleep(0);
  });
  try {
    const frame = await workflows.waitForFrame((value) => value.includes("Dokploy → Infisical") && value.includes("Rollback"));
    fs.writeFileSync(path.join(outputDirectory, "workflows.svg"), frameToSvg(frame, "Workflow selection TUI"));
  } finally {
    await act(async () => { await workflows.dispose(); });
  }

  const selection = await testRender(
    <App initialData={{
      client,
      connection: { url: "https://dokploy.example.com", version: "v0.31.4" },
      projects
    }} />,
    { width: 110, height: 32 }
  );
  try {
    await act(async () => { selection.mockInput.pressArrow("right"); });
    await selection.waitForFrame((value) => value.includes("Worker") && value.includes("Monitoring"));
    await act(async () => { selection.mockInput.pressArrow("down"); });
    await selection.waitForFrame((value) => value.includes("›    ◇ API"));
    await act(async () => { selection.mockInput.pressEnter(); });
    const frame = await selection.waitForFrame((value) => value.includes("selected 1/4"));
    fs.writeFileSync(path.join(outputDirectory, "project-selection.svg"), frameToSvg(frame, "Project and service selection TUI"));
  } finally {
    await act(async () => { await selection.dispose(); });
  }

  console.log(`Wrote screenshots to ${outputDirectory}`);
}

await capture();
