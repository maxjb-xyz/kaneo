import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("API integration: workspace tasks aggregation", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects unauthenticated requests", async () => {
    const member = await createWorkspaceMember();
    mockAnonymousSession();
    const { app } = createApp();
    const response = await app.request(
      `/api/task/workspace/${member.workspace.id}`,
    );
    expect(response.status).toBe(401);
  });

  it("pools tasks from every project, tagged with project info", async () => {
    const member = await createWorkspaceMember();
    const a = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Alpha",
      slug: "alpha",
    });
    const b = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Beta",
      slug: "beta",
    });

    await db.insert(schema.taskTable).values([
      {
        projectId: a.project.id,
        title: "Alpha todo",
        status: "to-do",
        number: 1,
        position: 0,
      },
      {
        projectId: b.project.id,
        title: "Beta progress",
        status: "in-progress",
        number: 1,
        position: 0,
      },
      {
        projectId: b.project.id,
        title: "Beta planned",
        status: "planned",
        number: 2,
        position: 1,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/task/workspace/${member.workspace.id}`,
    );
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: {
        columns: {
          slug: string;
          tasks: { title: string; projectSlug: string }[];
        }[];
        plannedTasks: { title: string }[];
        projectColumns: Record<string, string[]>;
        projects: { id: string; slug: string }[];
      };
    };

    const todo = data.columns.find((c) => c.slug === "to-do");
    expect(todo?.tasks.map((t) => t.title)).toContain("Alpha todo");
    expect(todo?.tasks[0]?.projectSlug).toBeDefined();

    const inProgress = data.columns.find((c) => c.slug === "in-progress");
    expect(inProgress?.tasks.map((t) => t.title)).toContain("Beta progress");

    expect(data.plannedTasks.map((t) => t.title)).toContain("Beta planned");
    expect(Object.keys(data.projectColumns)).toEqual(
      expect.arrayContaining([a.project.id, b.project.id]),
    );
    expect(data.projects).toHaveLength(2);
  });
});
