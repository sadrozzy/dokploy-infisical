import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { loadRuntimeConfig, persistRuntimeConfig, validateRuntimeConfig, type RuntimeConfig } from "../core/config";
import { DokployClient } from "../core/dokploy";
import { InfisicalClient } from "../core/infisical";
import { listMigrationHistory, type MigrationHistoryEntry } from "../core/history";
import { scanProjects as scanDokployProjects } from "../core/inventory";
import { buildMigrationPlan, rollbackMigration, runMigration, type MigrationPlan, type MigrationProgress } from "../core/migration";
import { collectRedeployTargets, queueRedeploys, type RedeployProgress } from "../core/redeploy";
import { buildReverseMigrationPlan, type ReversePlanSummary } from "../core/reverse";
import { inspectSyncStatuses, type SyncStatus } from "../core/status";
import { flattenProjectTree, projectSelectedState, projectServices, selectedProjects as filterSelectedProjects, toggleTreeRow } from "../core/tree";
import type { ConnectionInfo, DokployProject, ScanReport } from "../core/types";
import { theme } from "./theme";

type Screen = "loading" | "setup" | "connecting" | "mode" | "select" | "rollback-list" | "scanning" | "review" | "recovery" | "migrating" | "complete" | "redeploy-confirm" | "redeploying" | "redeploy-error" | "error";
type MigrationMode = "dokploy-to-infisical" | "infisical-to-dokploy";

interface LoadedData {
  client: DokployClient;
  infisical?: InfisicalClient;
  runtime?: RuntimeConfig;
  connection: ConnectionInfo;
  projects: DokployProject[];
  vaultProviderId?: string;
}

interface VaultProviderSummary { vaultProviderId: string; name: string }

export interface AppDependencies {
  initialData?: LoadedData;
  load?: () => Promise<LoadedData | null>;
  connect?: (config: RuntimeConfig) => Promise<LoadedData>;
  scan?: (client: DokployClient, projects: DokployProject[], onProgress: (completed: number, total: number, project: string) => void) => Promise<ScanReport>;
}

const SETUP_FIELDS: Array<{ key: keyof RuntimeConfig; label: string; placeholder: string; secret?: boolean }> = [
  { key: "dokployUrl", label: "Dokploy URL", placeholder: "https://dp.example.com" },
  { key: "dokployToken", label: "Dokploy API token", placeholder: "Paste token", secret: true },
  { key: "infisicalUrl", label: "Infisical URL", placeholder: "https://vault.example.com" },
  { key: "infisicalClientId", label: "Universal Auth Client ID", placeholder: "Client ID" },
  { key: "infisicalClientSecret", label: "Universal Auth Client Secret", placeholder: "Paste client secret", secret: true },
  { key: "infisicalProjectId", label: "Infisical Project ID", placeholder: "Project UUID" },
  { key: "infisicalEnvironment", label: "Environment", placeholder: "prod" },
  { key: "providerName", label: "Dokploy provider", placeholder: "vault-prod" }
];

const EMPTY_SETUP: RuntimeConfig = {
  dokployUrl: "", dokployToken: "", infisicalUrl: "", infisicalClientId: "", infisicalClientSecret: "",
  infisicalProjectId: "", infisicalEnvironment: "prod", providerName: "vault-prod"
};

const MIGRATION_STAGES: Array<{ phase: Exclude<MigrationProgress["phase"], "rollback">; label: string }> = [
  { phase: "snapshot", label: "Encrypted rollback snapshot" },
  { phase: "folders", label: "Infisical folders" },
  { phase: "secrets", label: "Infisical secret writes" },
  { phase: "dokploy", label: "Dokploy Vault references" },
  { phase: "verify-infisical", label: "Infisical verification" },
  { phase: "verify-dokploy", label: "Dokploy verification" },
  { phase: "complete", label: "Migration finalized" }
];

async function connectRuntime(config: RuntimeConfig): Promise<LoadedData> {
  const runtime = validateRuntimeConfig(config);
  const client = DokployClient.fromCredentials(runtime.dokployUrl, runtime.dokployToken);
  const infisical = new InfisicalClient({
    url: runtime.infisicalUrl, clientId: runtime.infisicalClientId, clientSecret: runtime.infisicalClientSecret,
    projectId: runtime.infisicalProjectId, environment: runtime.infisicalEnvironment
  });
  const [connection, projects, providers] = await Promise.all([
    client.connectionInfo(), client.projects(), client.get<VaultProviderSummary[]>("vaultProvider.all"), infisical.testConnection()
  ]).then(([connection, projects, providers]) => [connection, projects, providers] as const);
  const provider = providers.find((item) => item.name === runtime.providerName);
  if (!provider) throw new Error(`Dokploy vault provider '${runtime.providerName}' was not found`);
  await client.post("vaultProvider.testConnection", { vaultProviderId: provider.vaultProviderId });
  return { client, infisical, runtime, connection, projects, vaultProviderId: provider.vaultProviderId };
}

const defaultLoad: NonNullable<AppDependencies["load"]> = async () => {
  const runtime = loadRuntimeConfig();
  return runtime ? connectRuntime(runtime) : null;
};

function selectableCount(projects: DokployProject[]): number {
  return projects.reduce((total, project) => total + Math.max(1, projectServices(project).length), 0);
}

function statusView(status: SyncStatus | undefined): { color: string; label: string } {
  if (status === "synced") return { color: theme.accent, label: "Synced" };
  if (status === "outdated") return { color: theme.danger, label: "Outdated" };
  return { color: theme.muted, label: "Not synced" };
}

function Header({ connection, selected, total, screen }: { connection: ConnectionInfo | null; selected: number; total: number; screen: Screen }) {
  return <box flexDirection="column" gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>DOKPLOY</text><text fg={theme.muted}>×</text>
        <text fg={theme.cyan} attributes={TextAttributes.BOLD}>INFISICAL</text>
      </box>
      <text fg={theme.muted}>{screen === "setup" ? "first-run setup" : `selected ${selected}/${total}`}</text>
    </box>
    <text fg={theme.muted}>Interactive secrets migration · encrypted rollback</text>
    {connection ? <box flexDirection="row" gap={1}><text fg={theme.accent}>●</text><text fg={theme.text} attributes={TextAttributes.BOLD}>Dokploy</text><text fg={theme.muted}>{connection.version} · {connection.url}</text></box> : null}
  </box>;
}

function Footer({ screen, canRedeploy }: { screen: Screen; canRedeploy: boolean }) {
  const help = screen === "setup" ? "↑↓ navigate   type/paste value   enter next   ctrl+c quit"
    : screen === "mode" ? "↑↓ choose mode   enter open   q quit"
    : screen === "select" ? "↑↓ move   ←→ collapse/expand   space/enter select   tab Continue   m review   esc modes"
      : screen === "rollback-list" ? "↑↓ choose snapshot   enter rollback   esc modes"
      : screen === "review" ? "enter start migration   esc projects   q quit"
        : screen === "recovery" ? "type/paste recovery password   enter start   esc review"
          : screen === "complete" ? `${canRedeploy ? "enter/r redeploy selected services   " : ""}esc workflows   q quit`
            : screen === "redeploy-confirm" ? "enter confirm redeploy   esc cancel"
              : screen === "redeploy-error" ? "esc migration result   q quit"
                : screen === "migrating" || screen === "redeploying" ? "operation in progress · wait for completion" : "q quit";
  return <box border={["top"]} borderColor={theme.border} paddingTop={1}><text fg={theme.muted}>{help}</text></box>;
}

export function App({ initialData, load = defaultLoad, connect = connectRuntime, scan = scanDokployProjects }: AppDependencies) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>(initialData ? "select" : "loading");
  const [mode, setMode] = useState<MigrationMode>("dokploy-to-infisical");
  const [modeCursor, setModeCursor] = useState(0);
  const [client, setClient] = useState<DokployClient | null>(initialData?.client ?? null);
  const [infisical, setInfisical] = useState<InfisicalClient | null>(initialData?.infisical ?? null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(initialData?.runtime ?? null);
  const [vaultProviderId, setVaultProviderId] = useState(initialData?.vaultProviderId ?? "");
  const [connection, setConnection] = useState<ConnectionInfo | null>(initialData?.connection ?? null);
  const [projects, setProjects] = useState<DokployProject[]>(initialData?.projects ?? []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [actionFocused, setActionFocused] = useState(false);
  const [setupValues, setSetupValues] = useState<RuntimeConfig>(EMPTY_SETUP);
  const [setupCursor, setSetupCursor] = useState(0);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ScanReport | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0, project: "" });
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [migrationId, setMigrationId] = useState("");
  const [redeployProgress, setRedeployProgress] = useState<RedeployProgress | null>(null);
  const [redeployQueued, setRedeployQueued] = useState(0);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [reverseSummary, setReverseSummary] = useState<ReversePlanSummary | null>(null);
  const [syncStatuses, setSyncStatuses] = useState<Record<string, SyncStatus>>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [history, setHistory] = useState<MigrationHistoryEntry[]>([]);
  const [rollbackCursor, setRollbackCursor] = useState(0);
  const [selectedRollback, setSelectedRollback] = useState<MigrationHistoryEntry | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<"migration" | "rollback">("migration");

  const acceptLoaded = useCallback((result: LoadedData) => {
    setClient(result.client); setInfisical(result.infisical ?? null); setRuntime(result.runtime ?? null);
    setConnection(result.connection); setProjects(result.projects); setVaultProviderId(result.vaultProviderId ?? "");
    setStatusLoaded(false);
    setExpanded(new Set(result.projects.slice(0, 1).map((project) => project.projectId)));
    setScreen(initialData ? "select" : "mode");
  }, [initialData]);

  useEffect(() => {
    if (initialData) return;
    let active = true;
    void load().then((result) => {
      if (!active) return;
      if (!result) setScreen("setup"); else acceptLoaded(result);
    }).catch((reason) => { if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setScreen("error"); } });
    return () => { active = false; };
  }, [acceptLoaded, initialData, load]);

  const rows = useMemo(() => flattenProjectTree(projects, expanded), [expanded, projects]);
  const pickedProjects = useMemo(() => filterSelectedProjects(projects, selected), [projects, selected]);
  const totalSelectable = selectableCount(projects);
  const selectedProjectCount = pickedProjects.length;
  const selectedServiceCount = pickedProjects.reduce((total, project) => total + projectServices(project).length, 0);
  const redeployTargets = useMemo(() => collectRedeployTargets(pickedProjects), [pickedProjects]);
  const canRedeploy = recoveryAction === "migration" && redeployQueued === 0 && redeployTargets.length > 0;
  const redeploySelectionLabel = `${redeployTargets.length} selected ${redeployTargets.length === 1 ? "service" : "services"}`;

  useEffect(() => {
    if (screen !== "mode" || !client || !infisical || !runtime || statusLoading || statusLoaded) return;
    setStatusLoading(true);
    void inspectSyncStatuses(client, infisical, projects, runtime.providerName)
      .then(setSyncStatuses)
      .catch(() => setSyncStatuses({}))
      .finally(() => { setStatusLoading(false); setStatusLoaded(true); });
  }, [client, infisical, projects, runtime, screen, statusLoaded, statusLoading]);

  const submitSetup = useCallback(async () => {
    setScreen("connecting"); setError("");
    try {
      const validated = validateRuntimeConfig(setupValues);
      const result = await connect(validated);
      persistRuntimeConfig(validated);
      acceptLoaded(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setScreen("setup"); }
  }, [acceptLoaded, connect, setupValues]);

  const runScan = useCallback(async () => {
    if (!client || pickedProjects.length === 0) return;
    setScreen("scanning"); setProgress({ completed: 0, total: pickedProjects.length, project: "" });
    try {
      if (vaultProviderId) {
        for (const project of pickedProjects) {
          for (const environment of project.environments ?? []) {
            await client.get("vaultProvider.listSecretNames", {
              vaultProviderId,
              projectId: project.projectId,
              environmentId: environment.environmentId
            });
          }
        }
      }
      if (mode === "infisical-to-dokploy") {
        if (!infisical || !runtime) throw new Error("Infisical connection is unavailable");
        const result = await buildReverseMigrationPlan(client, infisical, pickedProjects, runtime.providerName);
        setReverseSummary(result);
        setPlan(result.plan);
        setReport(null);
      } else {
        const result = await scan(client, pickedProjects, (completed, total, project) => setProgress({ completed, total, project }));
        setReport(result);
        setReverseSummary(null);
        setPlan(buildMigrationPlan(result, runtime?.providerName ?? "vault-prod"));
      }
      setScreen("review");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setScreen("error"); }
  }, [client, infisical, mode, pickedProjects, runtime, scan, vaultProviderId]);

  const startMigration = useCallback(async () => {
    if (!client || !infisical || !runtime || (recoveryAction === "migration" && !plan) || (recoveryAction === "rollback" && !selectedRollback)) {
      setError("Migration credentials are unavailable. Complete first-run setup before writing changes."); setScreen("error"); return;
    }
    if (recoveryPassword.length < 10) { setError("Recovery password must contain at least 10 characters"); return; }
    setMigrationProgress(null); setRedeployQueued(0); setRedeployProgress(null); setScreen("migrating");
    try {
      const context = { dokploy: client, infisical, dokployUrl: runtime.dokployUrl, infisicalUrl: runtime.infisicalUrl,
        projectId: runtime.infisicalProjectId, environment: runtime.infisicalEnvironment };
      const snapshot = recoveryAction === "rollback"
        ? await rollbackMigration(context, selectedRollback!.id, recoveryPassword, setMigrationProgress)
        : await runMigration(context, plan!, recoveryPassword, setMigrationProgress);
      setMigrationId(snapshot.id); setRecoveryPassword(""); setScreen("complete");
      setStatusLoaded(false);
      setHistory(listMigrationHistory());
    } catch (reason) { setRecoveryPassword(""); setError(reason instanceof Error ? reason.message : String(reason)); setScreen("error"); }
  }, [client, infisical, plan, recoveryAction, recoveryPassword, runtime, selectedRollback]);

  const startRedeploy = useCallback(async () => {
    if (!client || redeployTargets.length === 0) { setScreen("complete"); return; }
    setError(""); setRedeployProgress({ completed: 0, total: redeployTargets.length, label: "Preparing redeploy queue" }); setScreen("redeploying");
    try {
      const queued = await queueRedeploys(client, redeployTargets, setRedeployProgress);
      setRedeployQueued(queued); setScreen("complete");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setScreen("redeploy-error");
    }
  }, [client, redeployTargets]);

  usePaste((event) => {
    const value = decodePasteBytes(event.bytes).replace(/[\r\n]+$/g, "");
    if (screen === "setup") {
      const field = SETUP_FIELDS[setupCursor];
      if (field) setSetupValues((current) => ({ ...current, [field.key]: current[field.key] + value }));
    } else if (screen === "recovery") setRecoveryPassword((current) => current + value);
  });

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") { renderer.destroy(); return; }
    if (screen === "setup") {
      const field = SETUP_FIELDS[setupCursor];
      if (!field) return;
      if (key.name === "up") setSetupCursor((current) => Math.max(0, current - 1));
      else if (key.name === "down" || key.name === "tab") setSetupCursor((current) => Math.min(SETUP_FIELDS.length - 1, current + 1));
      else if (key.name === "backspace") setSetupValues((current) => ({ ...current, [field.key]: current[field.key].slice(0, -1) }));
      else if (key.name === "return") { if (setupCursor === SETUP_FIELDS.length - 1) void submitSetup(); else setSetupCursor((current) => current + 1); }
      else if (!key.ctrl && !key.meta && key.sequence?.length === 1) setSetupValues((current) => ({ ...current, [field.key]: current[field.key] + key.sequence }));
      return;
    }
    if (screen === "recovery") {
      if (key.name === "escape") { setRecoveryPassword(""); setScreen(recoveryAction === "rollback" ? "rollback-list" : "review"); }
      else if (key.name === "backspace") setRecoveryPassword((current) => current.slice(0, -1));
      else if (key.name === "return") void startMigration();
      else if (!key.ctrl && !key.meta && key.sequence?.length === 1) setRecoveryPassword((current) => current + key.sequence);
      return;
    }
    if (key.name === "q" && screen !== "migrating" && screen !== "redeploying" && screen !== "scanning" && screen !== "connecting") { renderer.destroy(); return; }
    if (screen === "mode") {
      if (key.name === "up" || key.name === "k") setModeCursor((current) => (current + 2) % 3);
      else if (key.name === "down" || key.name === "j") setModeCursor((current) => (current + 1) % 3);
      else if (key.name === "return") {
        if (modeCursor === 2) {
          setHistory(listMigrationHistory()); setRollbackCursor(0); setScreen("rollback-list");
        } else {
          setMode(modeCursor === 0 ? "dokploy-to-infisical" : "infisical-to-dokploy");
          setSelected(new Set()); setCursor(0); setActionFocused(false); setScreen("select");
        }
      }
      return;
    }
    if (screen === "rollback-list") {
      if (key.name === "escape") setScreen("mode");
      else if ((key.name === "up" || key.name === "k") && history.length) setRollbackCursor((current) => (current - 1 + history.length) % history.length);
      else if ((key.name === "down" || key.name === "j") && history.length) setRollbackCursor((current) => (current + 1) % history.length);
      else if (key.name === "return" && history[rollbackCursor]) {
        setSelectedRollback(history[rollbackCursor]!); setRecoveryAction("rollback"); setError(""); setScreen("recovery");
      }
      return;
    }
    if (screen === "select") {
      if (key.name === "escape") { setScreen("mode"); return; }
      if (key.name === "tab") { setActionFocused((current) => !current); return; }
      if ((key.name === "m" || (actionFocused && key.name === "return")) && selected.size > 0) { void runScan(); return; }
      if (actionFocused) return;
      const row = rows[cursor]; if (!row) return;
      if (key.name === "up" || key.name === "k") setCursor((current) => (current - 1 + rows.length) % rows.length);
      else if (key.name === "down" || key.name === "j") setCursor((current) => (current + 1) % rows.length);
      else if (key.name === "right" && row.kind === "project") setExpanded((current) => new Set(current).add(row.project.projectId));
      else if (key.name === "left") {
        if (row.kind === "project") setExpanded((current) => { const next = new Set(current); next.delete(row.project.projectId); return next; });
        else { const parentIndex = rows.findIndex((candidate) => candidate.kind === "project" && candidate.project.projectId === row.project.projectId); if (parentIndex >= 0) setCursor(parentIndex); }
      } else if (key.name === "space" || key.name === "return") setSelected((current) => toggleTreeRow(row, current));
      else if (key.name === "a") {
        const allSelected = selected.size === totalSelectable;
        setSelected(allSelected ? new Set() : new Set(projects.flatMap((project) => {
          const services = projectServices(project); return services.length ? services.map((service) => service.id) : [`project:${project.projectId}`];
        })));
      }
      return;
    }
    if (screen === "review") { if (key.name === "escape") setScreen("select"); else if (key.name === "return" || key.name === "m") { setRecoveryAction("migration"); setError(""); setScreen("recovery"); } return; }
    if (screen === "complete") {
      if (key.name === "escape") setScreen("mode");
      else if ((key.name === "return" || key.name === "r") && canRedeploy) setScreen("redeploy-confirm");
      return;
    }
    if (screen === "redeploy-confirm") {
      if (key.name === "escape") setScreen("complete");
      else if (key.name === "return") void startRedeploy();
      return;
    }
    if (screen === "redeploy-error" && key.name === "escape") { setError(""); setScreen("complete"); return; }
    if (screen === "error" && key.name === "escape") setScreen(projects.length ? "mode" : "setup");
  });

  useEffect(() => { setCursor((current) => Math.min(current, Math.max(rows.length - 1, 0))); }, [rows.length]);
  const visibleRowCount = Math.max(4, dimensions.height - 18);
  const visibleStart = Math.min(Math.max(cursor - Math.floor(visibleRowCount / 2), 0), Math.max(rows.length - visibleRowCount, 0));
  const visibleRows = rows.slice(visibleStart, visibleStart + visibleRowCount);
  const setupRowCount = Math.min(SETUP_FIELDS.length, Math.max(3, dimensions.height - 18));
  const setupStart = Math.min(
    Math.max(setupCursor - Math.floor(setupRowCount / 2), 0),
    Math.max(SETUP_FIELDS.length - setupRowCount, 0)
  );
  const visibleSetupFields = SETUP_FIELDS.slice(setupStart, setupStart + setupRowCount);
  const migrationStageIndex = migrationProgress?.phase === "complete"
    ? MIGRATION_STAGES.length
    : MIGRATION_STAGES.findIndex((stage) => stage.phase === migrationProgress?.phase);

  return <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} padding={1} gap={1}>
    <Header connection={connection} selected={selected.size} total={totalSelectable} screen={screen} />

    {screen === "loading" || screen === "connecting" ? <box flexGrow={1} border borderStyle="rounded" borderColor={theme.border} padding={2}><text fg={theme.cyan}>◌ {screen === "loading" ? "Loading configuration…" : "Testing Dokploy and Infisical…"}</text></box> : null}

    {screen === "setup" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.cyan} title={` First-run setup · fields ${setupStart + 1}-${setupStart + visibleSetupFields.length} of ${SETUP_FIELDS.length} `} padding={1}>
      <text fg={theme.muted}>Credentials are stored in macOS Keychain; config.json contains no tokens.</text>
      {visibleSetupFields.map((field, offset) => {
        const index = setupStart + offset;
        const active = index === setupCursor; const rawValue = setupValues[field.key];
        const shown = field.secret && rawValue ? "•".repeat(Math.min(rawValue.length, 32)) : rawValue;
        return <box key={field.key} flexDirection="row" gap={1} backgroundColor={active ? theme.panelActive : theme.background} paddingX={1}>
          <text fg={active ? theme.accent : theme.muted}>{active ? "›" : " "}</text><text width={28} fg={active ? theme.text : "#b6c1d1"}>{field.label}</text>
          <text fg={shown ? theme.cyan : theme.muted}>{shown || field.placeholder}{active ? "█" : ""}</text>
        </box>;
      })}
      {error ? <text fg={theme.danger}>! {error}</text> : null}
      <box height={3} marginTop={1} border borderStyle="rounded" borderColor={setupCursor === SETUP_FIELDS.length - 1 ? theme.accent : theme.border} paddingX={1}><text fg={theme.accent} attributes={TextAttributes.BOLD}>Enter on last field · Connect & save</text></box>
    </box> : null}

    {screen === "mode" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.border} title=" Choose workflow " padding={1} gap={1}>
      {[
        ["Dokploy → Infisical", "Move raw values to /project/_shared and /project/service, then attach Vault refs"],
        ["Infisical → Dokploy", "Attach missing Vault refs from the existing folder hierarchy; no plaintext import"],
        ["Rollback", "Browse encrypted migration snapshots by project and restore one"]
      ].map(([title, description], index) => <box key={title} flexDirection="column" backgroundColor={modeCursor === index ? theme.panelActive : theme.background} paddingX={1}>
        <box flexDirection="row" gap={1}><text fg={modeCursor === index ? theme.accent : theme.muted}>{modeCursor === index ? "›" : " "}</text><text fg={modeCursor === index ? theme.text : "#b6c1d1"} attributes={TextAttributes.BOLD}>{title}</text></box>
        <text fg={theme.muted}>  {description}</text>
      </box>)}
      <box marginTop={1} border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="row" gap={2}>
        <text fg={theme.accent}>● Synced</text><text fg={theme.danger}>● Outdated</text><text fg={theme.muted}>● Not synced</text>
        {statusLoading ? <text fg={theme.cyan}>checking…</text> : null}
      </box>
    </box> : null}

    {screen === "rollback-list" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.warning} title=" Rollback history " padding={1}>
      {history.length === 0 ? <text fg={theme.muted}>No rollback snapshots found.</text> : history.map((entry, index) => {
        const active = index === rollbackCursor;
        const projectNames = entry.projects.length ? entry.projects.map((project) => project.name).join(", ") : "Legacy snapshot";
        const direction = entry.direction === "dokploy-to-infisical" ? "Dokploy → Infisical" : entry.direction === "infisical-to-dokploy" ? "Infisical → Dokploy" : "Unknown direction";
        return <box key={entry.id} flexDirection="column" backgroundColor={active ? theme.panelActive : theme.background} paddingX={1}>
          <box flexDirection="row" gap={1}><text fg={active ? theme.accent : theme.muted}>{active ? "›" : " "}</text><text fg={active ? theme.text : "#b6c1d1"} attributes={TextAttributes.BOLD}>{projectNames}</text><text fg={theme.muted}>{entry.status}</text></box>
          <text fg={theme.muted}>  {new Date(entry.createdAt).toLocaleString()} · {direction} · {entry.serviceCount} services · {entry.secretCount} secrets</text>
        </box>;
      })}
    </box> : null}

    {screen === "select" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.border} title={` Projects & services · ${visibleStart + 1}-${Math.min(visibleStart + visibleRowCount, rows.length)} of ${rows.length} `} padding={1}>
      {visibleRows.map((row, offset) => {
        const index = visibleStart + offset; const active = !actionFocused && index === cursor;
        const state = row.kind === "project" ? projectSelectedState(row.project, selected) : selected.has(row.service!.id) ? "all" : "none";
        const marker = state === "all" ? "◆" : state === "some" ? "◈" : "◇";
        const disclosure = row.kind === "project" ? (expanded.has(row.project.projectId) ? "▾" : "▸") : " ";
        return <box key={row.id} flexDirection="row" justifyContent="space-between" backgroundColor={active ? theme.panelActive : theme.background} paddingX={1}>
          <box flexDirection="row" gap={1}><text fg={active ? theme.accent : theme.muted}>{active ? "›" : " "}</text><text fg={theme.muted}>{row.depth ? "  " : disclosure}</text>
            <text fg={state === "all" ? theme.accent : state === "some" ? theme.warning : theme.muted}>{marker}</text>
            <text fg={active ? theme.text : "#b6c1d1"} attributes={row.kind === "project" ? TextAttributes.BOLD : undefined}>{row.service?.name ?? row.project.name}</text></box>
          {row.kind === "service" ? <text fg={theme.muted}>{row.service!.environment} · {row.service!.kind}</text> : (() => { const view = statusView(syncStatuses[row.project.projectId]); return <box flexDirection="row" gap={2}><text fg={view.color}>● {view.label}</text><text fg={theme.muted}>{projectServices(row.project).length} services</text></box>; })()}
        </box>;
      })}
      <box height={3} marginTop={1} border borderStyle="rounded" borderColor={actionFocused ? theme.accent : selected.size ? theme.cyan : theme.border} backgroundColor={actionFocused ? theme.panelActive : theme.background} paddingX={1} justifyContent="center">
        <box flexDirection="row"><text fg={selected.size ? theme.accent : theme.muted} attributes={selected.size ? TextAttributes.BOLD : undefined}>Continue with {selectedProjectCount} projects </text><text fg={theme.muted}>({selectedServiceCount} services)</text><text fg={selected.size ? theme.accent : theme.muted}>  →</text></box>
      </box>
    </box> : null}

    {screen === "scanning" ? <box flexGrow={1} border borderStyle="rounded" borderColor={theme.cyan} padding={2} flexDirection="column" gap={1}>
      <text fg={theme.cyan} attributes={TextAttributes.BOLD}>Building reversible migration plan</text><text fg={theme.text}>{progress.project || "Preparing inventory…"}</text><text fg={theme.muted}>{progress.completed}/{progress.total} projects complete</text>
    </box> : null}

    {screen === "review" && (report || reverseSummary) ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} title={` ${mode === "dokploy-to-infisical" ? "Dokploy → Infisical" : "Infisical → Dokploy"} review `} padding={1} gap={1}>
      {report ? <><box flexDirection="row" gap={3}><text fg={theme.accent} attributes={TextAttributes.BOLD}>{report.candidateCount} secrets</text><text fg={theme.cyan}>{report.referenceCount} Dokploy rewrites</text><text fg={report.warningCount ? theme.warning : theme.muted}>{report.warningCount} warnings</text></box>
      {report.projects.map((result) => <box key={result.projectId} flexDirection="row" justifyContent="space-between" paddingX={1}><text fg="#b6c1d1">{result.project}</text><text fg={result.candidates.length ? theme.accent : theme.muted}>{result.candidates.length} secrets · {result.references.length} rewrites</text></box>)}</> : null}
      {reverseSummary ? <><box flexDirection="row" gap={3}><text fg={theme.accent} attributes={TextAttributes.BOLD}>{reverseSummary.additionCount} refs to add</text><text fg={reverseSummary.conflictCount ? theme.danger : theme.muted}>{reverseSummary.conflictCount} raw conflicts skipped</text></box>
      {reverseSummary.projectRows.map((row) => <box key={row.projectId} flexDirection="row" justifyContent="space-between" paddingX={1}><text fg="#b6c1d1">{row.project}</text><text fg={row.conflicts ? theme.warning : theme.accent}>{row.additions} additions · {row.conflicts} skipped</text></box>)}</> : null}
      <box marginTop={1} border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column"><text fg={theme.muted}>{mode === "dokploy-to-infisical" ? "Existing Vault refs are immutable. Project env remains untouched." : "_shared refs attach directly to every selected service. Existing keys are never overwritten."}</text><text fg={theme.muted}>Any failure triggers automatic rollback. Redeploy is offered separately after verification.</text></box>
      <box height={3} marginTop={1} border borderStyle="rounded" borderColor={theme.accent} backgroundColor={theme.panelActive} paddingX={1} justifyContent="center"><text fg={theme.accent} attributes={TextAttributes.BOLD}>Enter · Start migration  →</text></box>
    </box> : null}

    {screen === "recovery" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.warning} title=" Recovery protection " padding={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>{recoveryAction === "rollback" ? "Enter the snapshot recovery password" : "Choose a recovery password"}</text><text fg={theme.muted}>{recoveryAction === "rollback" ? `Rollback ${selectedRollback?.projects.map((project) => project.name).join(", ") || selectedRollback?.id}` : "It encrypts the rollback snapshot. Minimum 10 characters; it is never stored."}</text>
      <box height={3} border borderStyle="rounded" borderColor={theme.accent} paddingX={1}><text fg={theme.cyan}>{recoveryPassword ? "•".repeat(Math.min(recoveryPassword.length, 48)) : "Type or paste password"}█</text></box>
      {error ? <text fg={theme.danger}>! {error}</text> : null}<text fg={theme.warning}>{recoveryAction === "rollback" ? "Enter will restore and verify the selected snapshot." : "Enter will apply the reviewed plan. Existing Vault refs remain untouched."}</text>
    </box> : null}

    {screen === "migrating" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={migrationProgress?.phase === "rollback" ? theme.warning : theme.cyan} title={migrationProgress?.phase === "rollback" ? " Automatic rollback " : " Migration running "} padding={2} gap={1}>
      {migrationProgress?.phase === "rollback" ? <>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>↶ Restoring previous state</text>
        <text fg={theme.text}>{migrationProgress.label}</text>
        <text fg={theme.muted}>{migrationProgress.completed}/{migrationProgress.total}</text>
      </> : MIGRATION_STAGES.map((stage, index) => {
        const done = migrationStageIndex > index;
        const active = migrationStageIndex === index;
        return <box key={stage.phase} flexDirection="row" gap={1}>
          <text fg={done ? theme.accent : active ? theme.cyan : theme.muted}>{done ? "✓" : active ? "●" : "○"}</text>
          <text width={32} fg={done ? theme.accent : active ? theme.text : theme.muted} attributes={active ? TextAttributes.BOLD : undefined}>{stage.label}</text>
          {active && migrationProgress ? <text fg={theme.muted}>{migrationProgress.completed}/{migrationProgress.total}</text> : null}
        </box>;
      })}
      <box marginTop={1} border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
        <text fg={theme.text}>{migrationProgress?.label ?? "Preparing encrypted rollback snapshot…"}</text>
        <text fg={theme.warning}>Do not close the terminal while this operation is running.</text>
      </box>
    </box> : null}

    {screen === "complete" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} title=" Migration complete " padding={2} gap={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>✓ {recoveryAction === "rollback" ? "Rollback restored and verified" : "Migration applied and verified"}</text>
      <text fg={theme.text}>Migration ID: {migrationId}</text>
      {redeployQueued > 0 ? <text fg={theme.cyan} attributes={TextAttributes.BOLD}>✓ {redeployQueued} redeploy requests queued in Dokploy</text> : <text fg={theme.muted}>Services have not been redeployed.</text>}
      <text fg={theme.muted}>{recoveryAction === "rollback" ? "The snapshot remains in history with rolled-back status." : "Keep the recovery password until you no longer need rollback."}</text>
      {canRedeploy ? <box height={3} marginTop={1} border borderStyle="rounded" borderColor={theme.cyan} backgroundColor={theme.panelActive} paddingX={1} justifyContent="center"><text fg={theme.cyan} attributes={TextAttributes.BOLD}>Enter · Redeploy {redeploySelectionLabel}  →</text></box> : null}
    </box> : null}

    {screen === "redeploy-confirm" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.warning} title=" Confirm redeploy " padding={2} gap={1}>
      <text fg={theme.warning} attributes={TextAttributes.BOLD}>Queue redeploy for {redeploySelectionLabel}?</text>
      <text fg={theme.muted}>This is separate from migration rollback. A queued deployment cannot be undone by this tool.</text>
      {redeployTargets.slice(0, 6).map((target) => <text key={`${target.kind}:${target.id}`} fg={theme.text}>• {target.label}</text>)}
      {redeployTargets.length > 6 ? <text fg={theme.muted}>…and {redeployTargets.length - 6} more</text> : null}
      <box height={3} marginTop={1} border borderStyle="rounded" borderColor={theme.warning} backgroundColor={theme.panelActive} paddingX={1} justifyContent="center"><text fg={theme.warning} attributes={TextAttributes.BOLD}>Enter · Confirm redeploy</text></box>
    </box> : null}

    {screen === "redeploying" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.cyan} title=" Queueing redeploys " padding={2} gap={1}>
      <text fg={theme.cyan} attributes={TextAttributes.BOLD}>● Sending explicit redeploy requests to Dokploy</text>
      <text fg={theme.text}>{redeployProgress?.label ?? "Preparing…"}</text>
      <text fg={theme.muted}>{redeployProgress?.completed ?? 0}/{redeployProgress?.total ?? redeployTargets.length}</text>
      <text fg={theme.warning}>Migration is already complete. These deployments are not part of rollback.</text>
    </box> : null}

    {screen === "redeploy-error" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.danger} title=" Redeploy failed " padding={2} gap={1}>
      <text fg={theme.danger} attributes={TextAttributes.BOLD}>Some redeploy requests may already be queued</text>
      <text fg={theme.text} wrapMode="word">{error}</text>
      <text fg={theme.muted}>The verified secrets migration remains applied. Press Esc to return to its result.</text>
    </box> : null}

    {screen === "error" ? <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={theme.danger} padding={2} gap={1}><text fg={theme.danger} attributes={TextAttributes.BOLD}>Operation failed</text><text fg={theme.text} wrapMode="word">{error}</text><text fg={theme.muted}>If writes had started, the migration engine attempted automatic rollback. Press Esc to return.</text></box> : null}
    <Footer screen={screen} canRedeploy={canRedeploy} />
  </box>;
}
