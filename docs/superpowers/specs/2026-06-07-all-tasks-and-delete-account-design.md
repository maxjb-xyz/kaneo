# Design: All Tasks page & Delete account

**Date:** 2026-06-07
**Status:** Approved (pending spec review)

Two independent features for the Kaneo web app + API:

1. **All Tasks** — a workspace-scoped page that pools tasks from every project in the
   active workspace, offering the same Backlog / Tasks (board+list) / Gantt views a single
   project has, plus the ability to create a task into any project.
2. **Delete account** — a button in account settings that permanently deletes the signed-in
   user's account, with guardrails against orphaning collaborators' data.

---

## Feature 1 — All Tasks

### Scope decisions

- **Project scope:** active workspace only. A user may belong to many workspaces; All Tasks
  shows tasks from every (non-archived) project in the currently-selected workspace, resolved
  via the session's `activeOrganizationId`.
- **Views:** the full project view set — Backlog, Tasks (kanban board with a board/list
  toggle), and Gantt — pooled across the workspace's projects.
- **Create:** add a task into any project via a project picker in the existing create modal.

### Why this is feasible

All four project view bodies (`KanbanBoard`, `ListView`, `BacklogListView`, and the Gantt
renderer) consume the same `ProjectWithTasks` shape: an object with `columns[]` (each column
has `id`/`slug`/`name`/`tasks[]`), plus `plannedTasks[]` and `archivedTasks[]`. If the backend
synthesizes one `ProjectWithTasks`-shaped payload from all projects' data, every view can be
reused as-is.

`KanbanBoard`, `ListView`, and `BacklogListView` are already standalone components taking a
`project` prop. The Gantt rendering is currently inlined in the gantt **route**
(`.../project/$projectId/gantt.tsx`), not a component — it must be extracted.

### Backend

New endpoint: `GET /task/workspace/:workspaceId`, registered in `apps/api/src/task/index.ts`,
guarded by the existing `workspaceAccess.fromWorkspace` middleware (same access model as other
workspace-scoped routes).

New controller `apps/api/src/task/controllers/get-workspace-tasks.ts`:

1. Load all non-archived projects in the workspace (`projectTable`, `archivedAt IS NULL`).
2. Bulk-load all tasks for those projects (same task selection shape as `get-tasks.ts`:
   id, title, number, description, status, priority, startDate, dueDate, position, createdAt,
   userId, assignee name/id/image, projectId), plus labels and external links keyed by task id.
   Each task additionally carries `projectName`, `projectSlug`, and `projectIcon`.
3. Bulk-load all columns for those projects (`columnTable`).
4. Build the synthesized payload:
   - `columns` = **union of all projects' columns keyed by `slug`**, deduped, ordered by the
     minimum `position` seen for that slug (ties broken by name). Each task buckets into the
     column whose slug equals its `status`.
   - `plannedTasks` / `archivedTasks` = pooled across all projects (status `planned` /
     `archived`), same as a single project.
   - `projectColumns`: a map `projectId → string[]` of each project's own column slugs. The
     client uses this to know, per card, which columns are valid drop targets.
   - `projects`: a small array of `{ id, name, slug, icon }` for the projects represented
     (used by the create modal's picker and project badges).
5. Return `{ data: <synthesized payload> }` (matching the `{ data }` envelope of `get-tasks.ts`).

No pagination for v1 (the per-project endpoint also returns everything by default).

### Frontend — routes & layout

New file-based routes under
`apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/all-tasks/`:

- `index.tsx` — `beforeLoad` redirect to `all-tasks/board` (mirrors the project `index.tsx`).
- `board.tsx` — Tasks view: `BoardToolbar` view switcher (board/list) backed by
  `useUserPreferencesStore` viewMode, rendering `KanbanBoard` or `ListView`.
- `backlog.tsx` — pooled `BacklogListView`.
- `gantt.tsx` — pooled `GanttView` (the newly extracted component).

New `apps/web/src/components/common/all-tasks-layout.tsx`, a sibling of `ProjectLayout`:
- Same `Layout` header shell.
- A Backlog / Tasks / Gantt switcher that routes between the three `all-tasks/*` routes.
- Workspace-scoped: shows the workspace crumb, **no** project crumb, and **no**
  per-project websocket subscription (`useProjectWebSocket` is project-bound and is omitted).

Sidebar: add an **"All Tasks"** item to `NavMain` (`apps/web/src/components/nav-main.tsx`),
linking to `/dashboard/workspace/$workspaceId/all-tasks`, alongside Projects / Members /
Invitations.

New query hook + fetcher:
- `apps/web/src/fetchers/task/get-workspace-tasks.ts` — calls the new endpoint.
- `apps/web/src/hooks/queries/task/use-get-workspace-tasks.ts` — `useQuery`, keyed by
  `["workspace-tasks", workspaceId]`.

All three route components read from this one hook and feed the synthesized project into the
shared view components. The pooled page keeps its data in the query cache / local state rather
than the single-project `useProjectStore`.

**Store-coupling caveat:** `KanbanBoard.handleDragEnd` (and the other view drag handlers)
currently persist optimistic updates by calling `setProject` from `useProjectStore`. Reusing
them as-is from the pooled page would clobber the single-project store. The multi-project mode
therefore routes optimistic updates through an injected callback (e.g. an optional
`onProjectChange?: (next: ProjectWithTasks) => void` prop) instead of writing `useProjectStore`
directly; when the prop is absent, the components fall back to the existing `useProjectStore`
behavior so single-project boards are unchanged. The pooled page passes a setter that updates
its local/query-cached copy.

### Frontend — multi-project drag

`KanbanBoard` (and the drag paths in `ListView` / `BacklogListView`) gain an **optional
multi-project mode**. Single-project boards are unaffected — the new behavior is gated behind a
prop (e.g. `projectColumns?: Record<string, string[]>`); when absent, current behavior is
byte-for-byte unchanged.

In multi-project mode:

- **Project is immutable per task.** A drag never changes a task's `projectId`; the persisted
  update keeps the task's own `projectId` (already true today — the drag spreads `...task`).
- **Valid drop target.** A card may only drop into a column whose `slug` exists in that card's
  own project (looked up via `projectColumns[task.projectId]`). A drop into a column the card's
  project lacks is rejected and the card **snaps back** to its origin (no mutation).
- **Status change** writes the destination column's slug as the task's status; the backend
  resolves the matching `columnId` within the task's own project (guaranteed to exist by the
  valid-target rule).
- **Position reconciliation.** After a drop, `position` is recomputed **per project within the
  affected column** — walk the column and assign each task `position = its index among
  same-project tasks only`, skipping interleaved foreign-project cards. This keeps every
  project's intra-column ordering correct without a global re-index. The same rule applies to
  planned/archived reordering in `BacklogListView`.

### Frontend — project badge

Each card (`kanban-board/task-card.tsx`), list row, backlog row, and Gantt row in the pooled
views shows a small **project badge** (project icon + slug) since tasks now span projects. The
badge data comes from the per-task `projectSlug`/`projectIcon` fields.

### Frontend — Gantt extraction (refactor of shipped code)

Extract the body of `.../project/$projectId/gantt.tsx` into a reusable
`apps/web/src/components/gantt/gantt-view.tsx` (`<GanttView project={...} />`). The existing
project gantt route renders `<GanttView>` fed by `useGetTasks(projectId)`; the All Tasks gantt
route renders the same component fed by `useGetWorkspaceTasks`. Behavior of the existing route
is unchanged. The Gantt task-rail label uses each task's own `projectSlug` (instead of the
single `project.slug`) so pooled rows read `PROJ-123` correctly.

### Frontend — create flow

`CreateTaskModal` (`apps/web/src/components/shared/modals/create-task-modal.tsx`) gains an
optional **project picker**:

- The modal already resolves a target project from (in order) the `projectId` prop, the
  `useProjectStore` project, or the route's `/project/:id` segment (`resolvedProjectId`).
- When **none** of those yields a project (the All Tasks case), render a project `<Select>`
  populated from the workspace's projects (`useGetProjects({ workspaceId })`, or the `projects`
  array already returned by the workspace-tasks query). The selected project becomes
  `resolvedProjectId`.
- The picker is **hidden** whenever a project is already resolved, so every existing call site
  is visually and behaviorally unchanged.
- On successful create from All Tasks, invalidate `["workspace-tasks", workspaceId]`.

### Backlog "Move all planned → To-do" caveat

`BacklogListView`'s host route has a "Move all planned to To-do" bulk action that assumes a
`to-do` column exists. Per project that's safe; in the pooled backlog it would orphan planned
tasks in any project lacking a `to-do` column. **This single bulk button is hidden in the All
Tasks backlog.** All other backlog behavior (per-task actions, create-into-planned, reorder)
works pooled. (Create-into-planned from All Tasks uses the project picker to choose the target.)

---

## Feature 2 — Delete account

### Scope decisions

- **Owned workspaces with other members → block.** If the user owns (membership role `owner`)
  any workspace that has more than one member, deletion is refused with a message telling them
  to transfer ownership or delete those workspaces first.
- **Solo-owned workspaces → deleted** along with the account (cascades their projects / tasks /
  columns).
- **Confirmation:** a simple confirm dialog (not type-to-confirm).

### Critical data-safety constraint

`task.assignee_id` (schema `taskTable.userId`) has `onDelete: "cascade"`. Deleting the user row
would therefore **delete every task assigned to that user across all workspaces**, including
shared workspaces owned by other people — silent data loss for collaborators.

Mitigation: **before** the user row is deleted, null out `task.assignee_id` for all tasks
assigned to the user that live in workspaces being **kept** (i.e. not the solo-owned workspaces
being deleted). Those tasks survive, unassigned. No schema/migration change — the FK stays; we
simply unassign before delete.

### Backend

Enable Better Auth's built-in `user.deleteUser` in `apps/api/src/auth.ts`:

```ts
user: {
  additionalFields: { /* existing locale field */ },
  deleteUser: {
    enabled: true,
    beforeDelete: async (user) => {
      // 1. Find workspaces the user owns (workspace_member.role === "owner").
      // 2. For each owned workspace, count members. If any has > 1 member,
      //    throw new APIError("BAD_REQUEST", { message: "Transfer ownership or
      //    delete these workspaces before deleting your account." }).
      // 3. soloOwnedWorkspaceIds = owned workspaces with exactly 1 member.
      // 4. UPDATE task SET assignee_id = NULL WHERE assignee_id = user.id
      //    AND project.workspace_id NOT IN soloOwnedWorkspaceIds
      //    (preserve tasks in kept workspaces from the assignee cascade).
      // 5. Delete soloOwnedWorkspaceIds (cascades projects/tasks/columns).
      // Better Auth then deletes the user row; session/account/workspace_member
      // rows cascade automatically.
    },
  },
}
```

Notes:
- Steps 4 and 5 should run in a transaction so a failure can't leave a half-deleted state.
- "Owner" = a `workspace_member` row with `role = "owner"` for this user (set at workspace
  creation). Member count is `COUNT(*)` of `workspace_member` rows for the workspace.
- Already-correct cascades needing no work: `session`, `account`, `workspace_member`, and
  everything under a deleted workspace (`project` → `task`/`column`).

### Frontend

`apps/web/src/lib/auth-client.ts` — Better Auth's `deleteUser` is available on the client once
enabled server-side (no extra client plugin needed; confirm during implementation).

On the **Information** settings page
(`apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/information.tsx`),
add a **"Danger zone"** section below the profile card:

- A red **"Delete account"** button.
- Clicking opens a simple `AlertDialog`: "This permanently deletes your account and cannot be
  undone." with Cancel / Delete actions.
- Confirm calls `authClient.deleteUser()`. On success, redirect to `/auth/sign-in` (clearing
  session). On error (e.g. the owned-workspace block), show the server message via `toast.error`.
- All new copy goes through `react-i18next` (matching the page's existing `t(...)` usage), with
  English and German strings (the app ships both, per `auth.ts` locale handling).

---

## Out of scope

- Cross-workspace "all tasks" (explicitly active-workspace-only).
- Type-to-confirm account deletion.
- Auto-creating a missing column on a foreign-column drop (foreign drops snap back instead).
- Pagination / virtualization of the pooled views.
- Account-deletion email verification flow (simple in-app confirm only).
- Ownership transfer UI (deletion is blocked and the user transfers via existing workspace UI).

## Testing

- **API unit/integration** (`tests/api/`, `tests/api-integration/`): `get-workspace-tasks`
  aggregation (union columns, pooled planned/archived, per-task project fields); `deleteUser`
  `beforeDelete` guard (blocks on co-owned workspace; deletes solo workspaces; nulls assignee on
  kept-workspace tasks rather than deleting them).
- **Web** (`apps/web/vitest.config.ts`): multi-project drag valid-target + per-project position
  reconciliation; create modal project-picker visibility (hidden when project resolved, shown
  when not); delete-account dialog confirm/cancel and error toast.
- Follow existing patterns; run `pnpm lint` and `pnpm build` before commit (pre-commit hook runs
  both).
