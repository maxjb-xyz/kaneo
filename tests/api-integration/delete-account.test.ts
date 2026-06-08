import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import prepareAccountDeletion from "../../apps/api/src/user/controllers/prepare-account-deletion";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function addMember(workspaceId: string, role = "member") {
  const userId = `user-${randomUUID()}`;
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      name: "Other Member",
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role,
    joinedAt: new Date(),
  });
  return user;
}

describe("API integration: prepareAccountDeletion", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("blocks deletion when the user owns a workspace with other members", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    await addMember(owner.workspace.id);

    await expect(prepareAccountDeletion(owner.user.id)).rejects.toThrow(
      /transfer ownership/i,
    );

    const [stillThere] = await db
      .select()
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, owner.workspace.id));
    expect(stillThere).toBeDefined();
  });

  it("deletes solo-owned workspaces (and their projects/tasks)", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: "Solo task",
      status: "to-do",
      number: 1,
      position: 0,
    });

    await prepareAccountDeletion(owner.user.id);

    const workspaces = await db
      .select()
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, owner.workspace.id));
    expect(workspaces).toHaveLength(0);

    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(tasks).toHaveLength(0);
  });

  it("removes the user row via the delete-user endpoint for a solo account", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    // NOTE: Better Auth exposes delete-user at /api/auth/delete-user (POST).
    // Validate this path in CI if the endpoint path ever changes.
    const response = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBeLessThan(500);

    const [stillThere] = await db
      .select()
      .from(schema.userTable)
      .where(eq(schema.userTable.id, owner.user.id));
    expect(stillThere).toBeUndefined();
  });

  it("unassigns the user's tasks in kept workspaces instead of deleting them", async () => {
    const otherOwner = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: otherOwner.workspace.id,
    });
    const member = await addMember(otherOwner.workspace.id, "member");

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.id,
        title: "Shared task",
        status: "to-do",
        number: 1,
        position: 0,
      })
      .returning();

    await prepareAccountDeletion(member.id);

    const [kept] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(kept).toBeDefined();
    expect(kept.userId).toBeNull();
  });
});
