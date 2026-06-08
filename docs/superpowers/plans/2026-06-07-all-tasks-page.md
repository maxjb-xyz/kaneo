# All Tasks Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-scoped "All Tasks" page that pools tasks from every project in the active workspace, with the same Backlog / Tasks (board+list) / Gantt views a single project has, plus the ability to create a task into any project.

**Architecture:** A single API endpoint aggregates the workspace's projects into one `ProjectWithTasks`-shaped payload whose columns are the union (by slug) of all projects' columns. The existing `KanbanBoard`, `ListView`, `BacklogListView`, and a newly-extracted `GanttView` render that payload unchanged. A new `AllTasksLayout` provides the Backlog/Tasks/Gantt switcher. Drag/drop gains an opt-in multi-project mode (valid-drop-target per card + per-project position reconciliation) that leaves single-project boards untouched.

**Tech Stack:** Hono + Drizzle (PostgreSQL) API; React 19, TanStack Router (file-based) + TanStack Query, dnd-kit, Zustand, react-i18next on the web.

---

## Background facts (verified against the codebase)

- Per-project tasks come from `GET /task/tasks/:projectId` → `get-tasks.ts`, returning `{ data: { id, name, slug, icon, ..., columns[], archivedTasks[], plannedTasks[] } }` where `columns[i]` = `{ id: slug, slug, name, icon, isFinal, tasks[] }` ([apps/api/src/task/controllers/get-tasks.ts:224-281](apps/api/src/task/controllers/get-tasks.ts#L224-L281)).
- Columns are **custom per project** (`columnTable`, project-specific `slug`/`name`/`position`) ([schema.ts:257-282](apps/api/src/database/schema.ts#L257-L282)).
- `workspaceAccess.fromParam("workspaceId")` middleware validates membership from a path param ([apps/api/src/utils/workspace-access-middleware.ts:243-244](apps/api/src/utils/workspace-access-middleware.ts#L243)).
- Web view components are standalone and take a `project: ProjectWithTasks` prop: `KanbanBoard`, `ListView` ([apps/web/src/components/kanban-board/index.tsx](apps/web/src/components/kanban-board/index.tsx), `components/list-view`), `BacklogListView` (`components/backlog-list-view`). Gantt is **inlined** in its route and must be extracted.
- `ProjectWithTasks` type: [apps/web/src/types/project/index.ts](apps/web/src/types/project/index.ts). `Task` type: [apps/web/src/types/task/index.ts](apps/web/src/types/task/index.ts).
- View switching uses `useUserPreferencesStore().viewMode` + `BoardToolbar` ([project board route](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board.tsx)).
- The hono client is `import { client } from "@kaneo/libs"`; request/response types via `InferRequestType`/`InferResponseType` from `"hono/client"`.
- Web tests: `apps/web/vitest.config.ts`. API integration tests: `tests/api-integration/` with `createApp()`, `createWorkspaceMember`, `createProjectFixture`.

## File Structure

**API**
- Create `apps/api/src/task/controllers/get-workspace-tasks.ts` — aggregation logic.
- Modify `apps/api/src/task/index.ts` — register `GET /workspace/:workspaceId`.
- Create `tests/api-integration/all-tasks.test.ts`.

**Web**
- Modify `apps/web/src/types/task/index.ts` — add optional `projectName`/`projectSlug`/`projectIcon`.
- Create `apps/web/src/fetchers/task/get-workspace-tasks.ts` + `apps/web/src/hooks/queries/task/use-get-workspace-tasks.ts`.
- Create `apps/web/src/components/gantt/gantt-view.tsx` (extracted) and modify the project gantt route to use it.
- Create `apps/web/src/components/common/all-tasks-layout.tsx`.
- Create routes under `.../workspace/$workspaceId/all-tasks/`: `index.tsx`, `board.tsx`, `backlog.tsx`, `gantt.tsx`.
- Modify `apps/web/src/components/nav-main.tsx` — add the nav item.
- Modify `apps/web/src/components/kanban-board/index.tsx` (+ list/backlog drag) — multi-project mode.
- Modify `apps/web/src/components/kanban-board/task-card.tsx` (+ list/backlog rows) — project badge.
- Modify `apps/web/src/components/shared/modals/create-task-modal.tsx` — project picker.

---

## Task 1: Workspace-tasks aggregation endpoint

**Files:**
- Create: `apps/api/src/task/controllers/get-workspace-tasks.ts`
- Modify: `apps/api/src/task/index.ts`
- Test: `tests/api-integration/all-tasks.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/api-integration/all-tasks.test.ts`:

```ts
import { randomUUID } from "node:crypto";
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
        columns: { slug: string; tasks: { title: string; projectSlug: string }[] }[];
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- all-tasks`
Expected: FAIL — 404 / route not found (and missing controller module).

- [ ] **Step 3: Implement the aggregation controller**

Create `apps/api/src/task/controllers/get-workspace-tasks.ts`:

```ts
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

  const linksData =
    taskIds.length > 0
      ? await db
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
      : [];

  const labelsByTask = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (!label.taskId) continue;
    const list = labelsByTask.get(label.taskId) ?? [];
    list.push({ id: label.id, name: label.name, color: label.color });
    labelsByTask.set(label.taskId, list);
  }

  const linksByTask = new Map<string, Array<(typeof linksData)[number] & { metadata: unknown }>>();
  for (const link of linksData) {
    const list = linksByTask.get(link.taskId) ?? [];
    list.push({
      ...link,
      metadata: link.metadata ? JSON.parse(link.metadata) : null,
    });
    linksByTask.set(link.taskId, list);
  }

  const columnRows = await db
    .select()
    .from(columnTable)
    .where(inArray(columnTable.projectId, projectIds))
    .orderBy(asc(columnTable.position));

  // projectId -> [slugs] (a card's valid drop targets in multi-project mode)
  const projectColumns: Record<string, string[]> = {};
  for (const col of columnRows) {
    (projectColumns[col.projectId] ??= []).push(col.slug);
  }

  // Union of columns by slug, ordered by the minimum position seen.
  const unionBySlug = new Map<
    string,
    { slug: string; name: string; icon: string | null; isFinal: boolean; minPos: number }
  >();
  for (const col of columnRows) {
    const existing = unionBySlug.get(col.slug);
    if (!existing) {
      unionBySlug.set(col.slug, {
        slug: col.slug,
        name: col.name,
        icon: col.icon,
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
      labels: labelsByTask.get(task.id) ?? [],
      externalLinks: linksByTask.get(task.id) ?? [],
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
```

- [ ] **Step 4: Register the route**

In [apps/api/src/task/index.ts](apps/api/src/task/index.ts), add the import alongside the other controller imports (after line 27's `import getTasks`):

```ts
import getWorkspaceTasks from "./controllers/get-workspace-tasks";
```

Then add a new route immediately after the `.get("/tasks/:projectId", ...)` chain (after its closing `)` near line 94), before `.patch("/bulk", ...)`:

```ts
  .get(
    "/workspace/:workspaceId",
    describeRoute({
      operationId: "listWorkspaceTasks",
      tags: ["Tasks"],
      description: "Get all tasks across every project in a workspace",
      responses: {
        200: {
          description: "Aggregated workspace tasks",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ workspaceId: v.string() })),
    workspaceAccess.fromParam("workspaceId"),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const tasks = await getWorkspaceTasks(workspaceId);
      return c.json(tasks);
    },
  )
```

(`describeRoute`, `resolver`, `validator`, `v`, and `workspaceAccess` are already imported in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:integration -- all-tasks`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/task/controllers/get-workspace-tasks.ts apps/api/src/task/index.ts tests/api-integration/all-tasks.test.ts
git commit -m "feat(api): add workspace tasks aggregation endpoint"
```

---

## Task 2: Web fetcher, query hook, and Task type fields

**Files:**
- Modify: `apps/web/src/types/task/index.ts`
- Create: `apps/web/src/fetchers/task/get-workspace-tasks.ts`
- Create: `apps/web/src/hooks/queries/task/use-get-workspace-tasks.ts`

- [ ] **Step 1: Add project fields to the Task type**

In [apps/web/src/types/task/index.ts](apps/web/src/types/task/index.ts), add three optional fields to the `Task` type (after `projectId: string;`):

```ts
  projectName?: string | null;
  projectSlug?: string | null;
  projectIcon?: string | null;
```

- [ ] **Step 2: Create the fetcher**

Create `apps/web/src/fetchers/task/get-workspace-tasks.ts`:

```ts
import { client } from "@kaneo/libs";

async function getWorkspaceTasks(workspaceId: string) {
  const response = await client.task.workspace[":workspaceId"].$get({
    param: { workspaceId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const json = await response.json();
  return json.data;
}

export default getWorkspaceTasks;
```

- [ ] **Step 3: Create the query hook**

Create `apps/web/src/hooks/queries/task/use-get-workspace-tasks.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import getWorkspaceTasks from "@/fetchers/task/get-workspace-tasks";

export function useGetWorkspaceTasks(workspaceId: string) {
  return useQuery({
    queryKey: ["workspace-tasks", workspaceId],
    queryFn: () => getWorkspaceTasks(workspaceId),
    refetchInterval: 30000,
    enabled: !!workspaceId,
  });
}
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @kaneo/web build`
Expected: build succeeds (the `client.task.workspace[":workspaceId"]` path is type-derived from the API route added in Task 1; if the API package's generated types aren't picked up, run `pnpm --filter @kaneo/api build` first).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types/task/index.ts apps/web/src/fetchers/task/get-workspace-tasks.ts apps/web/src/hooks/queries/task/use-get-workspace-tasks.ts
git commit -m "feat(web): add workspace-tasks fetcher, hook, and Task project fields"
```

---

## Task 3: Extract GanttView from the project gantt route

This refactors shipped code with **no behavior change**, then makes it reusable.

**Files:**
- Create: `apps/web/src/components/gantt/gantt-view.tsx`
- Modify: `apps/web/src/routes/.../project/$projectId/gantt.tsx`

- [ ] **Step 1: Create `GanttView` from the route body**

Create `apps/web/src/components/gantt/gantt-view.tsx`. Move the entire rendering logic from [the gantt route](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/gantt.tsx) (everything from the `parseTaskDate` helper through the returned JSX, lines 42-409) into a component with this signature:

```tsx
import type { ProjectWithTasks } from "@/types/project";

type GanttViewProps = {
  project: ProjectWithTasks | undefined;
  workspaceId: string;
  /** Search param taskId for the details sheet. */
  taskId?: string;
  onOpenTask: (taskId: string) => void;
  onCloseTask: () => void;
};

export function GanttView({
  project,
  workspaceId,
  taskId,
  onOpenTask,
  onCloseTask,
}: GanttViewProps) {
  /* ...moved logic... */
}
```

Required adaptations while moving (do NOT change visual behavior):
1. Replace `Route.useParams()` / `Route.useSearch()` usage with the `workspaceId`, `taskId` props.
2. Replace the three inline `navigate({ to: ".", search: { taskId: task.id } ... })` calls with `onOpenTask(task.id)`, and the close handler with `onCloseTask()`.
3. Replace the single `project?.slug` used in the task-rail label and search filter with **`task.projectSlug ?? project?.slug`** so pooled rows show their own project's `SLUG-number`. (Each task already carries `projectSlug` from Task 1/2.)
4. Keep `useGetTasks` OUT of this component — the project is passed in.
5. `TaskDetailsSheet` needs a `projectId`. Use **`taskId`-resolved task's `projectId`**: compute `const activeProjectId = allTasks.find((t) => t.id === taskId)?.projectId ?? project?.id ?? "";` and pass that to `TaskDetailsSheet`.

- [ ] **Step 2: Rewrite the project gantt route to use `GanttView`**

Replace the body of the project [gantt.tsx](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/gantt.tsx) `RouteComponent` so it keeps the route + data fetch + `ProjectLayout`, and delegates rendering:

```tsx
function RouteComponent() {
  const { projectId, workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const { data: project } = useGetTasks(projectId);

  return (
    <ProjectLayout projectId={projectId} workspaceId={workspaceId} activeView="gantt">
      <GanttView
        project={project}
        workspaceId={workspaceId}
        taskId={taskId}
        onOpenTask={(id) =>
          navigate({ to: ".", search: { taskId: id }, replace: true })
        }
        onCloseTask={() => navigate({ to: ".", search: {}, replace: true })}
      />
    </ProjectLayout>
  );
}
```

Keep the existing `Route` definition (`createFileRoute` + `validateSearch`) and `PageTitle` (move `PageTitle` into `GanttView` or keep it in the route — keep it in the route for the project page; `GanttView` itself should not render `PageTitle`).

- [ ] **Step 3: Verify the project Gantt still works**

Run: `pnpm --filter @kaneo/web build`
Then manually open a project's Gantt view: bars, task rail, search, and opening a task all behave exactly as before.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/gantt/gantt-view.tsx "apps/web/src/routes/_layout/_authenticated/dashboard/workspace/\$workspaceId/project/\$projectId/gantt.tsx"
git commit -m "refactor(web): extract reusable GanttView from project gantt route"
```

---

## Task 4: Multi-project drag mode in KanbanBoard

Add an opt-in mode so the pooled board enforces valid drop targets and reconciles positions per project. Absent the new prop, behavior is unchanged.

**Files:**
- Modify: `apps/web/src/components/kanban-board/index.tsx`
- Test: `apps/web/src/components/kanban-board/multi-project-drag.test.ts`

- [ ] **Step 1: Write a unit test for the position-reconciliation helper**

Create `apps/web/src/components/kanban-board/multi-project-drag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isValidDropTarget,
  reconcilePositionsByProject,
} from "./multi-project-drag";
import type Task from "@/types/task";

const t = (id: string, projectId: string): Task =>
  ({
    id,
    projectId,
    title: id,
    status: "to-do",
    number: 1,
    description: null,
    priority: "low",
    startDate: null,
    dueDate: null,
    position: 0,
    createdAt: "",
    userId: null,
    assigneeId: null,
    assigneeName: null,
  }) as Task;

describe("multi-project drag helpers", () => {
  it("assigns positions per project, skipping foreign cards", () => {
    // Column order: A0, B0, A1, B1 -> A:[0,1], B:[0,1]
    const column = [t("a0", "A"), t("b0", "B"), t("a1", "A"), t("b1", "B")];
    const result = reconcilePositionsByProject(column);
    expect(result.find((x) => x.id === "a0")?.position).toBe(0);
    expect(result.find((x) => x.id === "a1")?.position).toBe(1);
    expect(result.find((x) => x.id === "b0")?.position).toBe(0);
    expect(result.find((x) => x.id === "b1")?.position).toBe(1);
  });

  it("rejects a drop into a column the card's project lacks", () => {
    const projectColumns = { A: ["to-do", "done"], B: ["to-do", "shipped"] };
    expect(isValidDropTarget(t("a0", "A"), "shipped", projectColumns)).toBe(
      false,
    );
    expect(isValidDropTarget(t("b0", "B"), "shipped", projectColumns)).toBe(
      true,
    );
  });

  it("allows any column when projectColumns is undefined (single-project mode)", () => {
    expect(isValidDropTarget(t("a0", "A"), "anything", undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kaneo/web test -- multi-project-drag`
Expected: FAIL — `Cannot find module './multi-project-drag'`.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/components/kanban-board/multi-project-drag.ts`:

```ts
import type Task from "@/types/task";

/**
 * In multi-project mode a card may only move into a column (status slug) that
 * exists in its OWN project. When `projectColumns` is undefined we are in
 * single-project mode and every column is valid.
 */
export function isValidDropTarget(
  task: Pick<Task, "projectId">,
  destinationSlug: string,
  projectColumns: Record<string, string[]> | undefined,
): boolean {
  if (!projectColumns) return true;
  const slugs = projectColumns[task.projectId];
  if (!slugs) return false;
  return slugs.includes(destinationSlug);
}

/**
 * Reindex `position` per project within a single column: each task's position
 * is its index among same-project tasks only, preserving the visual order and
 * skipping interleaved foreign-project cards. Returns new task objects.
 */
export function reconcilePositionsByProject<T extends Task>(
  columnTasks: T[],
): T[] {
  const counters = new Map<string, number>();
  return columnTasks.map((task) => {
    const next = counters.get(task.projectId) ?? 0;
    counters.set(task.projectId, next + 1);
    return { ...task, position: next };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kaneo/web test -- multi-project-drag`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the helpers into KanbanBoard**

In [apps/web/src/components/kanban-board/index.tsx](apps/web/src/components/kanban-board/index.tsx):

5a. Add to imports:
```ts
import {
  isValidDropTarget,
  reconcilePositionsByProject,
} from "./multi-project-drag";
import type Task from "@/types/task";
```

5b. Extend props (line 29-32):
```ts
type KanbanBoardProps = {
  project: ProjectWithTasks;
  disableDragDrop?: boolean;
  projectColumns?: Record<string, string[]>;
  onProjectChange?: (next: ProjectWithTasks) => void;
};
```
and destructure: `function KanbanBoard({ project, disableDragDrop = false, projectColumns, onProjectChange }: KanbanBoardProps) {`.

5c. Add a commit helper that routes optimistic updates either to the injected callback or the existing store (so single-project boards are unchanged). After `const { setProject } = useProjectStore();`:
```ts
const commitProject = (next: ProjectWithTasks) => {
  if (onProjectChange) onProjectChange(next);
  else setProject(next);
};
```

5d. In `handleDragEnd`, replace the **cross-column** branch (the `else` block, lines 164-180) so it (i) rejects invalid targets and (ii) reconciles positions per project. Replace the whole `produce(...)` body's cross-column `else` with:

```ts
      } else {
        // Reject drops into a column the card's project doesn't have.
        if (!isValidDropTarget(task, destinationColumn.id, projectColumns)) {
          // Put the card back where it was; no mutation persisted.
          sourceColumn.tasks.splice(sourceTaskIndex, 0, task);
          return;
        }

        task.status = destinationColumn.id;
        const destinationIndex =
          overId === destinationColumn.id
            ? destinationColumn.tasks.length
            : destinationColumn.tasks.findIndex((t) => t.id === overId) + 1;

        destinationColumn.tasks.splice(destinationIndex, 0, task);

        const reconciledDest = projectColumns
          ? reconcilePositionsByProject(destinationColumn.tasks)
          : destinationColumn.tasks.map((t, index) => ({ ...t, position: index }));
        destinationColumn.tasks = reconciledDest as typeof destinationColumn.tasks;
        for (const t of destinationColumn.tasks) {
          updateTask({ ...t, status: destinationColumn.id, position: t.position });
        }

        const reconciledSource = projectColumns
          ? reconcilePositionsByProject(sourceColumn.tasks)
          : sourceColumn.tasks.map((t, index) => ({ ...t, position: index }));
        sourceColumn.tasks = reconciledSource as typeof sourceColumn.tasks;
        for (const t of sourceColumn.tasks) {
          updateTask({ ...t, position: t.position });
        }
      }
```

5e. In the **same-column** branch (lines 148-163), replace the reindex `forEach` with project-aware reconciliation when `projectColumns` is set:
```ts
        const reconciled = projectColumns
          ? reconcilePositionsByProject(destinationColumn.tasks)
          : destinationColumn.tasks.map((t, index) => ({ ...t, position: index }));
        destinationColumn.tasks = reconciled as typeof destinationColumn.tasks;
        for (const t of destinationColumn.tasks) {
          updateTask({ ...t, position: t.position });
        }
```
(remove the old `destinationColumn.tasks.forEach((t, index) => updateTask({ ...t, position: index }));` and the now-redundant `queryClient.invalidateQueries` — keep the invalidate if `projectColumns` is undefined to preserve current behavior; guard it: `if (!projectColumns) queryClient.invalidateQueries({ queryKey: ["projects", project.workspaceId] });`).

5f. Replace the two `setProject(updatedProject)` calls at the end of `handleDragEnd` with `commitProject(updatedProject)`.

- [ ] **Step 6: Verify single-project board unchanged + build**

Run: `pnpm --filter @kaneo/web build && pnpm --filter @kaneo/web test -- multi-project-drag`
Then manually drag a card on a normal project board — status change + reorder still persist.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/kanban-board/
git commit -m "feat(web): add multi-project drag mode to KanbanBoard"
```

> **Note for ListView / BacklogListView:** apply the same pattern (accept optional `projectColumns` + `onProjectChange`, guard their drag handlers with `isValidDropTarget`, reconcile with `reconcilePositionsByProject`) in their drag end handlers. Do this as a sibling commit, mirroring the exact changes above. If a view has no cross-column drag (pure reorder), only the `reconcilePositionsByProject` + `onProjectChange` parts apply.

---

## Task 5: Project badge on cards and rows

**Files:**
- Modify: `apps/web/src/components/kanban-board/task-card.tsx` (+ list row, backlog row, as siblings)

- [ ] **Step 1: Add a badge when the task carries project info**

Open [apps/web/src/components/kanban-board/task-card.tsx](apps/web/src/components/kanban-board/task-card.tsx). Near the task metadata row, add a conditional badge that renders only when `task.projectSlug` is present (i.e. the pooled view):

```tsx
{task.projectSlug ? (
  <span className="inline-flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
    {task.projectSlug.toUpperCase()}
  </span>
) : null}
```

Place it alongside the existing labels/metadata so it doesn't disturb single-project cards (where `projectSlug` is undefined and nothing renders).

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @kaneo/web build`
Expected: succeeds; single-project cards visually unchanged.

- [ ] **Step 3: Mirror to list + backlog rows**

Apply the same `task.projectSlug ?`-guarded badge to the row components used by `ListView` and `BacklogListView` (and the Gantt rail already shows `projectSlug-number` from Task 3).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/
git commit -m "feat(web): show project badge on pooled task cards/rows"
```

---

## Task 6: AllTasksLayout

**Files:**
- Create: `apps/web/src/components/common/all-tasks-layout.tsx`

Model it on [project-layout.tsx](apps/web/src/components/common/project-layout.tsx) but workspace-scoped: no `ProjectCrumbSelect`, no `useGetProject`, no `useProjectWebSocket`.

- [ ] **Step 1: Create the layout**

Create `apps/web/src/components/common/all-tasks-layout.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, SquareKanban, SquircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import WorkspaceCrumbSelect from "@/components/common/header/workspace-crumb-select";
import Layout from "@/components/common/layout";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/cn";

type AllTasksView = "backlog" | "board" | "gantt";

type AllTasksLayoutProps = {
  workspaceId: string;
  activeView: AllTasksView;
  headerActions?: ReactNode;
  children: ReactNode;
};

export default function AllTasksLayout({
  workspaceId,
  activeView,
  headerActions,
  children,
}: AllTasksLayoutProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const go = (view: AllTasksView) =>
    navigate({
      to:
        view === "backlog"
          ? "/dashboard/workspace/$workspaceId/all-tasks/backlog"
          : view === "gantt"
            ? "/dashboard/workspace/$workspaceId/all-tasks/gantt"
            : "/dashboard/workspace/$workspaceId/all-tasks/board",
      params: { workspaceId },
    });

  const tab = (view: AllTasksView, icon: ReactNode, label: string) => (
    <Button
      variant={activeView === view ? "secondary" : "ghost"}
      size="xs"
      onClick={() => go(view)}
      className={cn(
        "h-6 gap-1.5 rounded-md px-2 text-xs",
        activeView !== view && "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <Layout>
      <Layout.Header className="h-11 border-border/80 px-2">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1 h-7 w-7 cursor-pointer text-foreground/85 hover:text-foreground" />
            <div className="h-4 w-px shrink-0 bg-border/80" />
            <div className="hidden min-w-0 items-center gap-1 md:flex">
              <WorkspaceCrumbSelect />
              <span className="text-foreground/30 text-xs">/</span>
              <span className="text-sm font-medium">
                {t("navigation:sidebar.allTasks")}
              </span>
            </div>
            <div className="hidden h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-background p-0.5 sm:inline-flex">
              {tab("backlog", <SquircleDashed className="size-3.5" />, "Backlog")}
              {tab("board", <SquareKanban className="size-3.5" />, "Tasks")}
              {tab("gantt", <CalendarDays className="size-3.5" />, "Gantt")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{headerActions}</div>
        </div>
      </Layout.Header>
      <Layout.Content>{children}</Layout.Content>
    </Layout>
  );
}
```

> Confirm `WorkspaceCrumbSelect` and `Layout` import paths/exports match those used in `project-layout.tsx`. If `WorkspaceCrumbSelect` requires props, pass the same ones the project layout does.

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @kaneo/web build`
Expected: succeeds (the `to:` paths will exist after Task 7's routes are created; if the typed router complains, do this step after Task 7 and build then).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/common/all-tasks-layout.tsx
git commit -m "feat(web): add AllTasksLayout with view switcher"
```

---

## Task 7: All Tasks routes (index, board, backlog, gantt)

**Files:**
- Create under `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/all-tasks/`: `index.tsx`, `board.tsx`, `backlog.tsx`, `gantt.tsx`

- [ ] **Step 1: index redirect**

Create `all-tasks/index.tsx` (mirrors the project [index.tsx](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/index.tsx)):

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/all-tasks/",
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dashboard/workspace/$workspaceId/all-tasks/board",
      params: { workspaceId: params.workspaceId },
      replace: true,
    });
  },
});
```

- [ ] **Step 2: board route (kanban + list toggle)**

Create `all-tasks/board.tsx`. Model on the project [board.tsx](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board.tsx) with these differences: fetch via `useGetWorkspaceTasks(workspaceId)`; wrap in `AllTasksLayout`; keep the pooled data in local state (`useState<ProjectWithTasks>`) for optimistic drag updates instead of `useProjectStore`; pass `projectColumns` and `onProjectChange` into `KanbanBoard`/`ListView`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import AllTasksLayout from "@/components/common/all-tasks-layout";
import BoardToolbar from "@/components/board/board-toolbar";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import PageTitle from "@/components/page-title";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { useGetWorkspaceTasks } from "@/hooks/queries/task/use-get-workspace-tasks";
import useGetLabelsByWorkspace from "@/hooks/queries/label/use-get-labels-by-workspace";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import type { SortConfig } from "@/lib/sort-tasks";
import { sortTasks } from "@/lib/sort-tasks";
import type { ProjectWithTasks } from "@/types/project";
import { useUserPreferencesStore } from "@/store/user-preferences";

type BoardSearchParams = { taskId?: string };

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/all-tasks/board",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): BoardSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const { data } = useGetWorkspaceTasks(workspaceId);
  const { viewMode, setViewMode } = useUserPreferencesStore();
  const { data: users } = useGetActiveWorkspaceUsers(workspaceId);
  const { data: workspaceLabels = [] } = useGetLabelsByWorkspace(workspaceId);

  const [local, setLocal] = useState<ProjectWithTasks | null>(null);
  const [sort, setSort] = useState<SortConfig>({ field: "position", direction: "asc" });

  useEffect(() => {
    if (data) setLocal(data as unknown as ProjectWithTasks);
  }, [data]);

  const projectColumns = (data as { projectColumns?: Record<string, string[]> } | undefined)
    ?.projectColumns;

  const sortedProject = (() => {
    if (!local || sort.field === "position") return local;
    return {
      ...local,
      columns: local.columns.map((c) => ({ ...c, tasks: sortTasks(c.tasks, sort) })),
    };
  })();

  return (
    <AllTasksLayout workspaceId={workspaceId} activeView="board">
      <PageTitle title={t("navigation:sidebar.allTasks")} />
      <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
        <BoardToolbar
          project={local ?? undefined}
          users={users}
          workspaceLabels={workspaceLabels}
          viewMode={viewMode}
          setViewMode={setViewMode}
          sort={sort}
          onSortChange={setSort}
        />
        <div className="flex h-full flex-1 overflow-hidden bg-background">
          {sortedProject ? (
            viewMode === "board" ? (
              <KanbanBoard
                project={sortedProject}
                disableDragDrop={sort.field !== "position"}
                projectColumns={projectColumns}
                onProjectChange={setLocal}
              />
            ) : (
              <ListView
                project={sortedProject}
                disableDragDrop={sort.field !== "position"}
                projectColumns={projectColumns}
                onProjectChange={setLocal}
              />
            )
          ) : null}
        </div>
        <TaskDetailsSheet
          taskId={taskId}
          projectId={
            sortedProject?.columns
              .flatMap((c) => c.tasks)
              .find((tk) => tk.id === taskId)?.projectId ?? ""
          }
          workspaceId={workspaceId}
          onClose={() => navigate({ to: ".", search: {}, replace: true })}
        />
      </div>
    </AllTasksLayout>
  );
}
```

> `BoardToolbar` may require the filter props (`filters`, `updateFilter`, `updateLabelFilter`, `clearFilters`, `hasActiveFilters`) seen in the project board. Inspect `components/board/board-toolbar.tsx` and pass the same props; reuse `useTaskFiltersWithLabelsSupport(local, undefined, "")` exactly as the project board does, or pass no-op handlers if filters are out of scope for v1. Keep it consistent with the project board's usage.

- [ ] **Step 3: backlog route**

Create `all-tasks/backlog.tsx` modeled on the project [backlog.tsx](apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/backlog.tsx), with: data from `useGetWorkspaceTasks`; `AllTasksLayout activeView="backlog"`; local-state optimistic updates; pass `projectColumns`/`onProjectChange` to `BacklogListView`; and **omit the "Move all planned → To-do" button** (the `handleMoveAllPlannedToTodo` action and its toolbar button) because the target `to-do` column may not exist in every project. Keep filters/sort and the create button (the create modal handles project selection — Task 8).

- [ ] **Step 4: gantt route**

Create `all-tasks/gantt.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import AllTasksLayout from "@/components/common/all-tasks-layout";
import { GanttView } from "@/components/gantt/gantt-view";
import PageTitle from "@/components/page-title";
import { useGetWorkspaceTasks } from "@/hooks/queries/task/use-get-workspace-tasks";
import { useTranslation } from "react-i18next";
import type { ProjectWithTasks } from "@/types/project";

type GanttSearchParams = { taskId?: string };

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/all-tasks/gantt",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): GanttSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const { data } = useGetWorkspaceTasks(workspaceId);

  return (
    <AllTasksLayout workspaceId={workspaceId} activeView="gantt">
      <PageTitle title={t("navigation:sidebar.allTasks")} hideAppName />
      <GanttView
        project={data as unknown as ProjectWithTasks | undefined}
        workspaceId={workspaceId}
        taskId={taskId}
        onOpenTask={(id) => navigate({ to: ".", search: { taskId: id }, replace: true })}
        onCloseTask={() => navigate({ to: ".", search: {}, replace: true })}
      />
    </AllTasksLayout>
  );
}
```

- [ ] **Step 5: Regenerate the route tree & build**

The project uses TanStack Router file-based routing; the route tree is generated on dev/build.
Run: `pnpm --filter @kaneo/web build`
Expected: routes compile; `routeTree.gen.ts` includes the four new routes. Fix any typed-route path mismatches reported.

- [ ] **Step 6: Manual smoke test**

`pnpm dev`, open `/dashboard/workspace/<id>/all-tasks` → redirects to board; switch Backlog/Tasks/Gantt; toggle board/list; drag a card within a valid status; confirm a drag into a foreign-only column snaps back.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/routes/_layout/_authenticated/dashboard/workspace/\$workspaceId/all-tasks/"
git commit -m "feat(web): add All Tasks board/backlog/gantt routes"
```

---

## Task 8: Create-task project picker

**Files:**
- Modify: `apps/web/src/components/shared/modals/create-task-modal.tsx`

The modal already computes `resolvedProjectId = projectId || project?.id || routeProjectId || ""` ([create-task-modal.tsx:198-200](apps/web/src/components/shared/modals/create-task-modal.tsx#L198-L200)). Add a picker used only when that is empty.

- [ ] **Step 1: Add a selected-project state + projects query**

Add imports:
```ts
import useGetProjects from "@/hooks/queries/project/use-get-projects";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```
(confirm the Select primitive's exported names in `components/ui/select.tsx`.)

After the existing state declarations:
```ts
const [pickedProjectId, setPickedProjectId] = useState("");
const { data: workspaceProjects } = useGetProjects({
  workspaceId: workspace?.id || "",
});
```

- [ ] **Step 2: Fold the picked project into resolution**

Change the `resolvedProjectId` computation to prefer an explicit prop/route/store project, then the picked one:
```ts
const resolvedProjectId =
  projectId || project?.id || routeProjectId || pickedProjectId || "";
const needsProjectPicker = !(projectId || project?.id || routeProjectId);
```

- [ ] **Step 3: Render the picker when needed**

Near the top of the modal body (above the title input), render only when `needsProjectPicker`:
```tsx
{needsProjectPicker ? (
  <Select value={pickedProjectId} onValueChange={setPickedProjectId}>
    <SelectTrigger className="w-56">
      <SelectValue
        placeholder={t("common:modals.createTask.selectProject")}
      />
    </SelectTrigger>
    <SelectContent>
      {(workspaceProjects ?? []).map((p) => (
        <SelectItem key={p.id} value={p.id}>
          {p.name}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
) : null}
```

- [ ] **Step 4: Guard submit + invalidate the pooled query**

In `handleSubmit`, the early return already checks `!resolvedProjectId`, so submit is blocked until a project is picked. After a successful create, also invalidate the pooled query. Add near the other imports:
```ts
import { useQueryClient } from "@tanstack/react-query";
```
and in the component: `const queryClient = useQueryClient();`, then after `toast.success(...)` in `handleSubmit`:
```ts
if (needsProjectPicker && workspace?.id) {
  queryClient.invalidateQueries({ queryKey: ["workspace-tasks", workspace.id] });
}
```
Also disable the submit button when `needsProjectPicker && !pickedProjectId` (extend the existing `disabled={!title.trim()}` to `disabled={!title.trim() || (needsProjectPicker && !pickedProjectId)}`).

- [ ] **Step 5: Reset picker on close**

In `handleClose`, add `setPickedProjectId("");` alongside the other resets.

- [ ] **Step 6: Wire the modal into the All Tasks board/backlog routes**

In `all-tasks/board.tsx` and `all-tasks/backlog.tsx`, add a create button (header action or toolbar) that opens `<CreateTaskModal open={...} onClose={...} />` **without** a `projectId` prop (so the picker shows). For backlog, pass `status="planned"` to match the project backlog.

- [ ] **Step 7: Add i18n keys**

Add `common:modals.createTask.selectProject` = "Select a project" / "Projekt auswählen" to the create-task modal namespace (en + de).

- [ ] **Step 8: Verify build + manual test**

Run: `pnpm --filter @kaneo/web build`
Manual: from All Tasks, open create → pick a project → create → the task appears in the pooled view; from a normal project board, the picker is absent and creation works as before.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/shared/modals/create-task-modal.tsx apps/web/src/routes apps/web/src
git commit -m "feat(web): add project picker to create-task modal for All Tasks"
```

---

## Task 9: Sidebar "All Tasks" nav item + i18n

**Files:**
- Modify: `apps/web/src/components/nav-main.tsx`
- Modify: navigation i18n namespace (en + de)

- [ ] **Step 1: Add the nav item**

In [apps/web/src/components/nav-main.tsx](apps/web/src/components/nav-main.tsx), add an entry to `navItems` after Projects:

```ts
{
  title: t("navigation:sidebar.allTasks"),
  url: `/dashboard/workspace/${workspace.id}/all-tasks`,
  isActive: window.location.pathname.startsWith(
    `/dashboard/workspace/${workspace.id}/all-tasks`,
  ),
  badge: null,
},
```

- [ ] **Step 2: Add the i18n key**

Add `navigation:sidebar.allTasks` = "All Tasks" / "Alle Aufgaben" to the navigation namespace (en + de). Run `rg -l "sidebar" apps/web/src --glob "*navigation*"` to find the files.

- [ ] **Step 3: Verify build + manual**

Run: `pnpm --filter @kaneo/web build`
Manual: the sidebar shows "All Tasks"; clicking navigates to the board; the item highlights on all-tasks routes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/nav-main.tsx apps/web/src
git commit -m "feat(web): add All Tasks sidebar nav item"
```

---

## Task 10: Full build, lint, and tests

- [ ] **Step 1: Lint + typecheck + build the monorepo**

Run: `pnpm lint && pnpm build`
Expected: clean (the pre-commit hook runs these too).

- [ ] **Step 2: Run the test suites**

Run: `pnpm test` then `pnpm test:integration -- all-tasks`
Expected: all green.

- [ ] **Step 3: Final manual pass**

Verify across two projects with **different** custom columns: pooled board shows the union; a card only drops into its own project's columns; positions stay correct per project; create-into-any-project works; Backlog has no "Move all" button; Gantt shows per-project `SLUG-number`.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(web): All Tasks polish and fixups"
```

---

## Self-Review notes

- **Spec coverage:** aggregation endpoint (Task 1); fetcher/hook + Task fields (Task 2); GanttView extraction (Task 3); multi-project full drag with valid-target + per-project reconciliation + store-coupling via `onProjectChange` (Task 4); project badge (Task 5); AllTasksLayout (Task 6); board/backlog/gantt routes incl. hidden "Move all" (Task 7); create-modal project picker (Task 8); sidebar nav (Task 9); full verification (Task 10). All spec sections mapped.
- **Type consistency:** helpers `isValidDropTarget` / `reconcilePositionsByProject` are defined in Task 4 and consumed there; `KanbanBoard` props `projectColumns?` + `onProjectChange?` are introduced in Task 4 and used in Task 7; `GanttView` signature defined in Task 3 and used in Task 7; `useGetWorkspaceTasks` defined in Task 2 and used in Tasks 7.
- **Known follow-through (flagged inline, not placeholders):** ListView/BacklogListView must receive the same `projectColumns`/`onProjectChange` drag treatment as KanbanBoard (Task 4 note) and the same badge (Task 5 step 3); `BoardToolbar` filter props must match the project board's usage (Task 7 step 2 note). These require reading the specific component's current props at implementation time and mirroring the documented pattern.
