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

function frameToReadmeHeroSvg(frame: string): string {
  const lines = frame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n");
  const rows = lines.map((line, index) => {
    const className = line.includes("›    ◆ API") || line.includes("Continue with")
      ? "terminal accent"
      : "terminal";
    return '<text x="20" y="' + (58 + index * 19) + '" class="' + className + '">' +
      escapeXml(line || " ") + "</text>";
  }).join("\n    ");

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500" viewBox="0 0 1200 500" role="img" aria-labelledby="title desc">',
    '  <title id="title">dokploy-infisical</title>',
    '  <desc id="desc">A minimal banner with a real OpenTUI project selection screen generated from the application.</desc>',
    '  <defs><clipPath id="tui-frame"><rect width="1030" height="697" rx="16"/></clipPath></defs>',
    '  <rect width="1200" height="500" rx="24" fill="#0b100e"/>',
    '  <path d="M0 499.5h1200" stroke="#1d2923"/>',
    '  <g font-family="IBM Plex Sans, Segoe UI, sans-serif">',
    '    <g transform="translate(58 61)">',
    '      <rect width="32" height="32" rx="8" fill="#20c56b"/>',
    '      <path d="M9 16h14M16 9v14" stroke="#072414" stroke-width="3" stroke-linecap="round"/>',
    '      <text x="46" y="23" fill="#f4f7f5" font-family="JetBrains Mono, SFMono-Regular, Consolas, monospace" font-size="18" font-weight="700">dokploy-infisical</text>',
    '    </g>',
    '    <text x="58" y="182" fill="#f4f7f5" font-size="46" font-weight="650" letter-spacing="-1.2">Secrets,</text>',
    '    <text x="58" y="234" fill="#f4f7f5" font-size="46" font-weight="650" letter-spacing="-1.2">under control.</text>',
    '    <text x="58" y="292" fill="#98a49e" font-size="17">Review the plan. Migrate safely.</text>',
    '    <text x="58" y="319" fill="#98a49e" font-size="17">Roll back when you need to.</text>',
    '    <g transform="translate(58 378)" fill="#c9d1cd" font-size="13" font-weight="550">',
    '      <circle cx="7" cy="7" r="7" fill="#173d29"/>',
    '      <path d="M3.8 7l2.1 2.2L10.5 4" fill="none" stroke="#45df89" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    '      <text x="22" y="11">Real TUI</text>',
    '      <circle cx="116" cy="7" r="7" fill="#173d29"/>',
    '      <path d="M112.8 7l2.1 2.2 4.6-5.2" fill="none" stroke="#45df89" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    '      <text x="131" y="11">Encrypted rollback</text>',
    '      <circle cx="290" cy="7" r="7" fill="#173d29"/>',
    '      <path d="M286.8 7l2.1 2.2 4.6-5.2" fill="none" stroke="#45df89" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    '      <text x="305" y="11">Verified</text>',
    '    </g>',
    '  </g>',
    '  <g transform="translate(552 54) scale(.565)">',
    '    <rect width="1030" height="697" rx="16" fill="#080c12" stroke="#318a57" stroke-width="2"/>',
    '    <circle cx="22" cy="22" r="6" fill="#46524b"/>',
    '    <circle cx="42" cy="22" r="6" fill="#46524b"/>',
    '    <circle cx="62" cy="22" r="6" fill="#20c56b"/>',
    '    <text x="50%" y="27" text-anchor="middle" class="terminal-title">dokploy-infisical · project selection</text>',
    '    <style>',
    '      .terminal-title { fill: #7f8da3; font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
    '      .terminal { fill: #d8e1ee; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }',
    '      .accent { fill: #42df87; font-weight: 700; }',
    '    </style>',
    '    <g clip-path="url(#tui-frame)">',
    '      ' + rows,
    '    </g>',
    '  </g>',
    '</svg>',
    ''
  ].join("\n");
}

async function capture(): Promise<void> {
  const outputDirectory = path.resolve(import.meta.dir, "../docs/screenshots");
  const assetsDirectory = path.resolve(import.meta.dir, "../docs/assets");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.mkdirSync(assetsDirectory, { recursive: true });

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
    fs.writeFileSync(path.join(assetsDirectory, "readme-hero.svg"), frameToReadmeHeroSvg(frame));
  } finally {
    await act(async () => { await selection.dispose(); });
  }

  console.log(`Wrote screenshots to ${outputDirectory}`);
}

await capture();
