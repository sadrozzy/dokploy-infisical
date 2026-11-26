import type { DokployProject, DokployServiceSummary } from "./types";

export interface ProjectTreeService {
  id: string;
  projectId: string;
  environmentId: string;
  environment: string;
  kind: "application" | "compose";
  name: string;
}

export interface ProjectTreeRow {
  id: string;
  kind: "project" | "service";
  project: DokployProject;
  service?: ProjectTreeService;
  depth: number;
}

function serviceNode(project: DokployProject, environmentId: string, environment: string, kind: ProjectTreeService["kind"], service: DokployServiceSummary): ProjectTreeService | null {
  const rawId = kind === "application" ? service.applicationId : service.composeId;
  if (!rawId) return null;
  return { id: `${kind}:${rawId}`, projectId: project.projectId, environmentId, environment, kind, name: service.name };
}

export function projectServices(project: DokployProject): ProjectTreeService[] {
  return (project.environments ?? []).flatMap((environment) => [
    ...(environment.applications ?? []).map((service) => serviceNode(project, environment.environmentId, environment.name, "application", service)),
    ...(environment.compose ?? []).map((service) => serviceNode(project, environment.environmentId, environment.name, "compose", service))
  ]).filter((service): service is ProjectTreeService => Boolean(service));
}

export function flattenProjectTree(projects: DokployProject[], expanded: Set<string>): ProjectTreeRow[] {
  return projects.flatMap((project) => {
    const parent: ProjectTreeRow = { id: `project:${project.projectId}`, kind: "project", project, depth: 0 };
    if (!expanded.has(project.projectId)) return [parent];
    return [parent, ...projectServices(project).map<ProjectTreeRow>((service) => ({
      id: service.id,
      kind: "service",
      project,
      service,
      depth: 1
    }))];
  });
}

export function projectSelectedState(project: DokployProject, selected: Set<string>): "none" | "some" | "all" {
  const services = projectServices(project);
  if (services.length === 0) return selected.has(`project:${project.projectId}`) ? "all" : "none";
  const count = services.filter((service) => selected.has(service.id)).length;
  return count === 0 ? "none" : count === services.length ? "all" : "some";
}

export function toggleTreeRow(row: ProjectTreeRow, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  if (row.kind === "service" && row.service) {
    if (next.has(row.service.id)) next.delete(row.service.id);
    else next.add(row.service.id);
    return next;
  }
  const services = projectServices(row.project);
  const state = projectSelectedState(row.project, selected);
  if (services.length === 0) {
    const id = `project:${row.project.projectId}`;
    if (next.has(id)) next.delete(id);
    else next.add(id);
  } else if (state === "all") {
    for (const service of services) next.delete(service.id);
  } else {
    for (const service of services) next.add(service.id);
  }
  return next;
}

export function selectedProjects(projects: DokployProject[], selected: Set<string>): DokployProject[] {
  return projects.flatMap((project) => {
    const selectedServiceIds = new Set(projectServices(project).filter((service) => selected.has(service.id)).map((service) => service.id));
    if (selectedServiceIds.size === 0 && !selected.has(`project:${project.projectId}`)) return [];
    return [{
      ...project,
      environments: (project.environments ?? []).map((environment) => ({
        ...environment,
        applications: (environment.applications ?? []).filter((service) => service.applicationId && selectedServiceIds.has(`application:${service.applicationId}`)),
        compose: (environment.compose ?? []).filter((service) => service.composeId && selectedServiceIds.has(`compose:${service.composeId}`))
      }))
    }];
  });
}
