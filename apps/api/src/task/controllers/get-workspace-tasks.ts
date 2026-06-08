import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  externalLinkTable,
  labelTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";

async function getWorkspaceTasks(workspaceId: string) {
  const projects = await db
    .select()
    .from(projectTable)
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
      ),
    );

  const base = {
    id: `workspace-${workspaceId}`,
    name: "All Tasks",
    slug: "all",
    icon: "Layout",
    description: null as string | null,
    isPublic: false,
    workspaceId,
  };

  if (projects.length === 0) {
    return {
      data: {
        ...base,
        columns: [],
        archivedTasks: [],
        plannedTasks: [],
        projects: [],
        projectColumns: {} as Record<string, string[]>,
      },
    };
  }

  const projectIds = projects.map((p) => p.id);
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const taskRows = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      number: taskTable.number,
      description: taskTable.description,
      status: taskTable.status,
      priority: taskTable.priority,
      startDate: taskTable.startDate,
      dueDate: taskTable.dueDate,
      position: taskTable.position,
      createdAt: taskTable.createdAt,
      userId: taskTable.userId,
      assigneeName: userTable.name,
      assigneeId: userTable.id,
      assigneeImage: userTable.image,
      projectId: taskTable.projectId,
    })
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(inArray(taskTable.projectId, projectIds))
    .orderBy(asc(taskTable.position));

  const taskIds = taskRows.map((t) => t.id);

  const labelsData =
    taskIds.length > 0
      ? await db
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
      : [];

  const externalLinksData =
    taskIds.length > 0
      ? await db
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
      : [];

  const taskLabelsMap = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (label.taskId) {
      if (!taskLabelsMap.has(label.taskId)) {
        taskLabelsMap.set(label.taskId, []);
      }
      taskLabelsMap.get(label.taskId)?.push({
        id: label.id,
        name: label.name,
        color: label.color,
      });
    }
  }

  const taskExternalLinksMap = new Map<
    string,
    Array<{
      id: string;
      taskId: string;
      integrationId: string;
      resourceType: string;
      externalId: string;
      url: string;
      title: string | null;
      metadata: Record<string, unknown> | null;
    }>
  >();
  for (const externalLink of externalLinksData) {
    if (!taskExternalLinksMap.has(externalLink.taskId)) {
      taskExternalLinksMap.set(externalLink.taskId, []);
    }
    taskExternalLinksMap.get(externalLink.taskId)?.push({
      ...externalLink,
      metadata: externalLink.metadata
        ? JSON.parse(externalLink.metadata)
        : null,
    });
  }

  const columnRows = await db
    .select()
    .from(columnTable)
    .where(inArray(columnTable.projectId, projectIds))
    .orderBy(asc(columnTable.position));

  const projectColumns: Record<string, string[]> = {};
  for (const col of columnRows) {
    if (!projectColumns[col.projectId]) {
      projectColumns[col.projectId] = [];
    }
    projectColumns[col.projectId].push(col.slug);
  }

  const unionBySlug = new Map<
    string,
    {
      slug: string;
      name: string;
      icon: string | null;
      isFinal: boolean;
      minPos: number;
    }
  >();
  for (const col of columnRows) {
    const existing = unionBySlug.get(col.slug);
    if (!existing) {
      unionBySlug.set(col.slug, {
        slug: col.slug,
        name: col.name,
        icon: col.icon ?? null,
        isFinal: col.isFinal,
        minPos: col.position,
      });
    } else if (col.position < existing.minPos) {
      existing.minPos = col.position;
    }
  }
  const unionColumns = [...unionBySlug.values()].sort(
    (x, y) => x.minPos - y.minPos || x.slug.localeCompare(y.slug),
  );

  const enrich = (task: (typeof taskRows)[number]) => {
    const project = projectById.get(task.projectId);
    return {
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
      projectName: project?.name ?? null,
      projectSlug: project?.slug ?? null,
      projectIcon: project?.icon ?? null,
    };
  };

  const columns = unionColumns.map((col) => ({
    id: col.slug,
    slug: col.slug,
    name: col.name,
    icon: col.icon,
    isFinal: col.isFinal,
    tasks: taskRows.filter((t) => t.status === col.slug).map(enrich),
  }));

  const archivedTasks = taskRows
    .filter((t) => t.status === "archived")
    .map(enrich);
  const plannedTasks = taskRows
    .filter((t) => t.status === "planned")
    .map(enrich);

  return {
    data: {
      ...base,
      columns,
      archivedTasks,
      plannedTasks,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        icon: p.icon,
      })),
      projectColumns,
    },
  };
}

export default getWorkspaceTasks;
