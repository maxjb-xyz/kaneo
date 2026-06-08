import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertValidTaskStatus } from "../validate-task-fields";
import getNextTaskNumber from "./get-next-task-number";

async function createTask({
  projectId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
}: {
  projectId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";

  await assertValidTaskStatus(resolvedStatus, projectId);

  // Fall back to the project's default assignee when the caller didn't choose
  // one. An explicit assignee always wins.
  let effectiveUserId = userId || null;
  if (!effectiveUserId) {
    const [project] = await db
      .select({ defaultAssigneeId: projectTable.defaultAssigneeId })
      .from(projectTable)
      .where(eq(projectTable.id, projectId));
    effectiveUserId = project?.defaultAssigneeId ?? null;
  }

  const [assignee] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, effectiveUserId ?? ""));

  const nextTaskNumber = await getNextTaskNumber(projectId);

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, resolvedStatus),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        column?.id
          ? eq(taskTable.columnId, column.id)
          : eq(taskTable.status, resolvedStatus),
      ),
    );

  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const [createdTask] = await db
    .insert(taskTable)
    .values({
      projectId,
      userId: effectiveUserId,
      title: title || "",
      status: resolvedStatus,
      columnId: column?.id ?? null,
      startDate: startDate || null,
      dueDate: dueDate || null,
      description: description || "",
      priority: resolvedPriority,
      number: nextTaskNumber + 1,
      position: nextPosition,
    })
    .returning();

  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  return {
    ...createdTask,
    assigneeName: assignee?.name,
  };
}

export default createTask;
