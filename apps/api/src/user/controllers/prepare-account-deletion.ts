import { APIError } from "better-auth/api";
import { count, eq, inArray } from "drizzle-orm";
import db, { schema } from "../../database";

/**
 * Prepares the database for a user-row deletion performed by Better Auth's
 * `deleteUser`. Must run BEFORE the user row is removed.
 *
 * Rules:
 *  1. If the user owns (workspace_member.role === "owner") any workspace that
 *     has more than one member, refuse.
 *  2. Null out the assignee on every task assigned to the user (the assignee FK
 *     cascades on user delete; without this, deleting the account would delete
 *     collaborators' tasks in workspaces the user does not own).
 *  3. Delete the user's solo workspaces (the only member is this user); cascades
 *     their projects/tasks/columns.
 */
async function prepareAccountDeletion(userId: string): Promise<void> {
  const memberships = await db
    .select({
      workspaceId: schema.workspaceUserTable.workspaceId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, userId));

  if (memberships.length > 0) {
    const workspaceIds = memberships.map((m) => m.workspaceId);

    const memberCounts = await db
      .select({
        workspaceId: schema.workspaceUserTable.workspaceId,
        count: count(),
      })
      .from(schema.workspaceUserTable)
      .where(inArray(schema.workspaceUserTable.workspaceId, workspaceIds))
      .groupBy(schema.workspaceUserTable.workspaceId);

    const countByWorkspace = new Map(
      memberCounts.map((row) => [row.workspaceId, Number(row.count)]),
    );

    const ownedWithOthers = memberships.filter(
      (m) =>
        m.role === "owner" && (countByWorkspace.get(m.workspaceId) ?? 1) > 1,
    );
    if (ownedWithOthers.length > 0) {
      throw new APIError("BAD_REQUEST", {
        message:
          "Transfer ownership or delete the workspaces you own before deleting your account.",
      });
    }

    const soloWorkspaceIds = memberships
      .map((m) => m.workspaceId)
      .filter((id) => (countByWorkspace.get(id) ?? 1) === 1);

    await db.transaction(async (tx) => {
      await tx
        .update(schema.taskTable)
        .set({ userId: null })
        .where(eq(schema.taskTable.userId, userId));

      if (soloWorkspaceIds.length > 0) {
        await tx
          .delete(schema.workspaceTable)
          .where(inArray(schema.workspaceTable.id, soloWorkspaceIds));
      }
    });
  }
}

export default prepareAccountDeletion;
