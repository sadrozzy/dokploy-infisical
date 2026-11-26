export interface DokployServiceSummary {
  applicationId?: string;
  composeId?: string;
  name: string;
  appName?: string;
}

export interface DokployEnvironment {
  environmentId: string;
  name: string;
  env?: string | null;
  applications?: DokployServiceSummary[];
  compose?: DokployServiceSummary[];
}

export interface DokployProject {
  projectId: string;
  name: string;
  env?: string | null;
  environments?: DokployEnvironment[];
}

export interface ConnectionInfo {
  url: string;
  version: string;
}

export interface SecretCandidate {
  projectId: string;
  project: string;
  environment: string;
  service: string;
  field: "env" | "buildArgs" | "buildSecrets";
  key: string;
  secretPath: string;
  reference: string;
  value: string;
  ownerType: "project" | "environment" | "application" | "compose";
  ownerId: string;
}

export interface ProjectReferenceRewrite {
  projectId: string;
  project: string;
  environment: string;
  service: string;
  field: SecretCandidate["field"];
  key: string;
  projectKeys: string[];
  strategy: "shared-vault" | "service-vault";
  replacementReference: string;
  ownerType: "environment" | "application" | "compose";
  ownerId: string;
}

export interface EnvironmentSource {
  ownerType: "project" | "environment" | "application" | "compose";
  ownerId: string;
  project: string;
  environment: string;
  service: string;
  field: SecretCandidate["field"];
  value: string;
  createEnvFile?: boolean;
}

export interface ProjectScanResult {
  projectId: string;
  project: string;
  candidates: SecretCandidate[];
  references: ProjectReferenceRewrite[];
  sources: EnvironmentSource[];
  warnings: string[];
}

export interface ScanReport {
  projects: ProjectScanResult[];
  candidateCount: number;
  referenceCount: number;
  warningCount: number;
}
