import type { DokployClient } from "./dokploy";
import type {
  DokployProject,
  ProjectReferenceRewrite,
  ProjectScanResult,
  ScanReport,
  SecretCandidate,
  EnvironmentSource
} from "./types";

const SECRET_KEY_PATTERN = /(?:^|_)(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|JWT|CREDENTIALS?|ACCESS_KEY|SECRET_KEY|WEBHOOK_SECRET|DATABASE_URL|DB_URL|REDIS_URL|MONGO(?:DB)?_URI|DSN)(?:$|_)/i;
const PRIVATE_VALUE_PATTERN = /^(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@)/i;
const BOOTSTRAP_PATTERN = /(?:^|[^a-z0-9])(infisical|vault)(?:$|[^a-z0-9])/i;
const PROJECT_REFERENCE_PATTERN = /\$\{\{project\.([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g;
const EXACT_PROJECT_REFERENCE_PATTERN = /^\$\{\{project\.([A-Za-z_][A-Za-z0-9_.-]*)\}\}$/;
const EXACT_VAULT_REFERENCE_PATTERN = /^\$\{\{vault\.[^}]+\}\}$/;

interface DotenvEntry { key: string; value: string }
interface ServiceDetails {
  env?: string | null;
  buildArgs?: string | null;
  buildSecrets?: string | null;
  createEnvFile?: boolean;
}

export function parseDotenv(text: string | null | undefined): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = match[2] ?? "";
    const quote = value[0] === "\"" || value[0] === "'" ? value[0] : "";
    if (quote) {
      value = value.slice(1);
      while (!endsWithUnescapedQuote(value, quote) && index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index] ?? ""}`;
      }
      if (endsWithUnescapedQuote(value, quote)) value = value.slice(0, -1);
      if (quote === "\"") value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    entries.push({ key, value });
  }
  return entries;
}

function endsWithUnescapedQuote(value: string, quote: string): boolean {
  if (!value.endsWith(quote)) return false;
  let slashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 0;
}

export function slugify(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "unnamed";
}

export function isSecretCandidate(key: string, value: string): boolean {
  if (!value || value.includes("${{vault.")) return false;
  return SECRET_KEY_PATTERN.test(key) || PRIVATE_VALUE_PATTERN.test(value);
}

export function isBootstrapService(name: string, appName = ""): boolean {
  return BOOTSTRAP_PATTERN.test(name) || BOOTSTRAP_PATTERN.test(appName);
}

export function destinationPath(
  project: string,
  environment: string,
  service: string,
  field: SecretCandidate["field"],
  scope: "project" | "environment" | "service"
): string {
  const projectSlug = slugify(project);
  if (scope === "project" || scope === "environment") return `/${projectSlug}/_shared`;
  return `/${projectSlug}/${slugify(service)}`;
}

export function extractProjectReferences(value: string): string[] {
  return [...value.matchAll(PROJECT_REFERENCE_PATTERN)].map((match) => match[1] as string);
}

function resolveProjectKey(key: string, shared: Map<string, string>, stack: string[] = []): string {
  if (stack.includes(key)) throw new Error(`Cyclic project reference: ${[...stack, key].join(" -> ")}`);
  const value = shared.get(key);
  if (value === undefined) throw new Error(`Missing project shared variable: ${key}`);
  return resolveProjectExpression(value, shared, [...stack, key]);
}

export function resolveProjectExpression(value: string, shared: Map<string, string>, stack: string[] = []): string {
  return value.replace(PROJECT_REFERENCE_PATTERN, (_match, key: string) => resolveProjectKey(key, shared, stack));
}

function makeCandidate(input: {
  project: DokployProject;
  environment: string;
  service: string;
  field: SecretCandidate["field"];
  key: string;
  value: string;
  ownerType: SecretCandidate["ownerType"];
  ownerId: string;
  scope: "project" | "environment" | "service";
}): SecretCandidate {
  const secretPath = destinationPath(input.project.name, input.environment, input.service, input.field, input.scope);
  return {
    projectId: input.project.projectId,
    project: input.project.name,
    environment: input.environment,
    service: input.service,
    field: input.field,
    key: input.key,
    secretPath,
    reference: `\${{vault.vault-prod.${secretPath.replace(/^\//, "")}:${input.key}}}`,
    value: input.value,
    ownerType: input.ownerType,
    ownerId: input.ownerId
  };
}

function addServiceCandidates(candidates: SecretCandidate[], references: ProjectReferenceRewrite[], warnings: string[], shared: Map<string, string>, ensureSharedSecret: (key: string) => boolean, input: {
  project: DokployProject;
  environment: string;
  service: string;
  field: SecretCandidate["field"];
  text: string | null | undefined;
  scope: "project" | "environment" | "service";
  ownerType: "environment" | "application" | "compose";
  ownerId: string;
}): void {
  for (const entry of parseDotenv(input.text)) {
    const projectKeys = extractProjectReferences(entry.value);
    const exact = entry.value.match(EXACT_PROJECT_REFERENCE_PATTERN);
    let resolved = entry.value;
    if (projectKeys.length) {
      if (!projectKeys.every(ensureSharedSecret)) continue;
      try {
        resolved = resolveProjectExpression(entry.value, shared);
      } catch (error) {
        warnings.push(`${input.service}/${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    if (exact) {
      const projectKey = exact[1] as string;
      references.push({
        projectId: input.project.projectId,
        project: input.project.name,
        environment: input.environment,
        service: input.service,
        field: input.field,
        key: entry.key,
        projectKeys,
        strategy: "shared-vault",
        replacementReference: EXACT_VAULT_REFERENCE_PATTERN.test(resolved)
          ? resolved
          : `\${{vault.vault-prod.${slugify(input.project.name)}/_shared:${projectKey}}}`,
        ownerType: input.ownerType,
        ownerId: input.ownerId
      });
      continue;
    }

    if (isSecretCandidate(entry.key, resolved) || projectKeys.length > 0) {
      const candidate = makeCandidate({ ...input, key: entry.key, value: resolved });
      candidates.push(candidate);
      references.push({
        projectId: input.project.projectId,
        project: input.project.name,
        environment: input.environment,
        service: input.service,
        field: input.field,
        key: entry.key,
        projectKeys,
        strategy: "service-vault",
        replacementReference: candidate.reference,
        ownerType: input.ownerType,
        ownerId: input.ownerId
      });
    }
  }
}

async function scanProject(client: DokployClient, project: DokployProject): Promise<ProjectScanResult> {
  const candidates: SecretCandidate[] = [];
  const references: ProjectReferenceRewrite[] = [];
  const warnings: string[] = [];
  const sources: EnvironmentSource[] = [{
    ownerType: "project",
    ownerId: project.projectId,
    project: project.name,
    environment: "shared",
    service: "_shared",
    field: "env",
    value: project.env ?? ""
  }];
  const sharedEntries = parseDotenv(project.env);
  const shared = new Map(sharedEntries.map((entry) => [entry.key, entry.value]));
  const sharedSecretKeys = new Set<string>();

  const ensureSharedSecret = (key: string): boolean => {
    if (sharedSecretKeys.has(key)) return true;
    try {
      const resolved = resolveProjectKey(key, shared);
      if (resolved.includes("${{vault.") && !EXACT_VAULT_REFERENCE_PATTERN.test(resolved)) {
        warnings.push(`shared/${key}: inline Vault reference cannot be safely flattened; left unchanged`);
        return false;
      }
      sharedSecretKeys.add(key);
      if (!EXACT_VAULT_REFERENCE_PATTERN.test(resolved)) {
        candidates.push(makeCandidate({
          project,
          environment: "shared",
          service: "_shared",
          field: "env",
          key,
          value: resolved,
          ownerType: "project",
          ownerId: project.projectId,
          scope: "project"
        }));
      }
      return true;
    } catch (error) {
      warnings.push(`shared/${key}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  for (const entry of sharedEntries) {
    try {
      resolveProjectKey(entry.key, shared);
      ensureSharedSecret(entry.key);
    } catch (error) {
      warnings.push(`shared/${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const environment of project.environments ?? []) {
    sources.push({
      ownerType: "environment", ownerId: environment.environmentId, project: project.name,
      environment: environment.name, service: "_shared", field: "env", value: environment.env ?? ""
    });
    addServiceCandidates(candidates, references, warnings, shared, ensureSharedSecret, {
      project, environment: environment.name, service: "_shared", field: "env", text: environment.env, scope: "environment",
      ownerType: "environment", ownerId: environment.environmentId
    });
    for (const application of environment.applications ?? []) {
      if (isBootstrapService(application.name, application.appName ?? "")) {
        warnings.push(`Skipped bootstrap application ${application.name}`);
        continue;
      }
      if (!application.applicationId) continue;
      try {
        const details = await client.get<ServiceDetails>("application.one", { applicationId: application.applicationId });
        for (const field of ["env", "buildArgs", "buildSecrets"] as const) {
          sources.push({
            ownerType: "application", ownerId: application.applicationId, project: project.name,
            environment: environment.name, service: application.name, field, value: details[field] ?? "",
            createEnvFile: details.createEnvFile
          });
          addServiceCandidates(candidates, references, warnings, shared, ensureSharedSecret, {
            project, environment: environment.name, service: application.name, field, text: details[field], scope: "service",
            ownerType: "application", ownerId: application.applicationId
          });
        }
      } catch (error) {
        warnings.push(`Unreadable application ${application.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const compose of environment.compose ?? []) {
      if (isBootstrapService(compose.name, compose.appName ?? "")) {
        warnings.push(`Skipped bootstrap compose ${compose.name}`);
        continue;
      }
      if (!compose.composeId) continue;
      try {
        const details = await client.get<ServiceDetails>("compose.one", { composeId: compose.composeId });
        sources.push({
          ownerType: "compose", ownerId: compose.composeId, project: project.name,
          environment: environment.name, service: compose.name, field: "env", value: details.env ?? "",
          createEnvFile: details.createEnvFile
        });
        addServiceCandidates(candidates, references, warnings, shared, ensureSharedSecret, {
          project, environment: environment.name, service: compose.name, field: "env", text: details.env, scope: "service",
          ownerType: "compose", ownerId: compose.composeId
        });
      } catch (error) {
        warnings.push(`Unreadable compose ${compose.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { projectId: project.projectId, project: project.name, candidates, references, sources, warnings };
}

export async function scanProjects(
  client: DokployClient,
  projects: DokployProject[],
  onProgress?: (completed: number, total: number, project: string) => void
): Promise<ScanReport> {
  const results: ProjectScanResult[] = [];
  for (const [index, project] of projects.entries()) {
    results.push(await scanProject(client, project));
    onProgress?.(index + 1, projects.length, project.name);
  }
  return {
    projects: results,
    candidateCount: results.reduce((total, result) => total + result.candidates.length, 0),
    referenceCount: results.reduce((total, result) => total + result.references.length, 0),
    warningCount: results.reduce((total, result) => total + result.warnings.length, 0)
  };
}
