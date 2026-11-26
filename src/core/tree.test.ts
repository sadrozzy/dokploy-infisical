import { expect, test } from "bun:test";
import type { DokployProject } from "./types";
import { flattenProjectTree, projectSelectedState, selectedProjects, toggleTreeRow } from "./tree";

const projects: DokployProject[] = [{
  projectId: "p1", name: "Project", environments: [{
    environmentId: "prod", name: "prod",
    applications: [{ applicationId: "web", name: "Web" }],
    compose: [{ composeId: "worker", name: "Worker" }]
  }]
}];

test("expands projects and selects parent services", () => {
  const rows = flattenProjectTree(projects, new Set(["p1"]));
  expect(rows.map((row) => row.id)).toEqual(["project:p1", "application:web", "compose:worker"]);
  const selected = toggleTreeRow(rows[0]!, new Set());
  expect(projectSelectedState(projects[0]!, selected)).toBe("all");
  expect(selectedProjects(projects, selected)[0]?.environments?.[0]?.applications).toHaveLength(1);
});
