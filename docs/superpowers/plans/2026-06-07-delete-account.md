# Delete Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user permanently delete their own account from account settings, blocking deletion when they co-own a workspace with others and never destroying collaborators' assigned tasks.

**Architecture:** Enable Better Auth's built-in `user.deleteUser` with a `beforeDelete` guard. The guard logic lives in a standalone, testable controller (`prepareAccountDeletion`) that (a) blocks if the user owns any workspace with other members, (b) nulls the assignee on every task assigned to the user so the `task.assignee_id` `ON DELETE CASCADE` can't delete collaborators' tasks, and (c) deletes the user's solo workspaces. The frontend adds a "Danger zone" with a simple confirm dialog calling `authClient.deleteUser()`.

**Tech Stack:** Hono + Better Auth + Drizzle (PostgreSQL) on the API; React 19 + TanStack Router + react-i18next on the web.

---

## Background facts (verified against the codebase)

- `task.assignee_id` (`taskTable.userId`) has `onDelete: "cascade"` ([apps/api/src/database/schema.ts:330](apps/api/src/database/schema.ts#L330)). Deleting a user would otherwise delete **every** task assigned to them, across all workspaces.
- `workspace` is **not** referenced by `user`; ownership is a `workspace_member` row with `role = "owner"` ([schema.ts:121-144](apps/api/src/database/schema.ts#L121-L144)). Deleting a `workspace` row cascades its `project` → `task`/`column`, members, invitations, and roles.
- `session`, `account`, `workspace_member` all cascade on user delete — no work needed.
- DB access: `import db, { schema } from "../../database"` (controllers) / `"./database"` (auth.ts). Drizzle operators from `"drizzle-orm"`.
- `APIError` is imported from `"better-auth/api"` (already used in [auth.ts:18](apps/api/src/auth.ts#L18)).
- Integration tests live in `tests/api-integration/`, use `createApp()` from `apps/api/src/index`, and the fixtures in [tests/api-integration/helpers/fixtures.ts](tests/api-integration/helpers/fixtures.ts) (`createWorkspaceMember`, `createProjectFixture`).

## File Structure

- **Create** `apps/api/src/user/controllers/prepare-account-deletion.ts` — the guard + cleanup logic, exported as a pure async function taking a `userId`. One responsibility: make the DB safe for a user-row delete, or throw if disallowed.
- **Modify** `apps/api/src/auth.ts` — add `deleteUser` config to the existing `user: { ... }` block, calling `prepareAccountDeletion`.
- **Create** `tests/api-integration/delete-account.test.ts` — integration coverage of the guard.
- **Modify** `apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/information.tsx` — add the Danger zone section + delete dialog.
- **Modify** web i18n `settings` namespace files — add Danger-zone copy (English + German).

---

## Task 1: Account-deletion guard controller

**Files:**
- Create: `apps/api/src/user/controllers/prepare-account-deletion.ts`
- Test: `tests/api-integration/delete-account.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/api-integration/delete-account.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import prepareAccountDeletion from "../../apps/api/src/user/controllers/prepare-account-deletion";
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

    // Workspace must be untouched.
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

  it("unassigns the user's tasks in kept workspaces instead of deleting them", async () => {
    // Workspace owned by someone else; the deleting user is just a member.
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- delete-account`
Expected: FAIL — `Cannot find module '.../user/controllers/prepare-account-deletion'`.

- [ ] **Step 3: Implement the guard controller**

Create `apps/api/src/user/controllers/prepare-account-deletion.ts`:

```ts
import { APIError } from "better-auth/api";
import { count, eq, inArray } from "drizzle-orm";
import db, { schema } from "../../database";

/**
 * Prepares the database for a user-row deletion performed by Better Auth's
 * `deleteUser`. Must run BEFORE the user row is removed.
 *
 * Rules:
 *  1. If the user owns (workspace_member.role === "owner") any workspace that
 *     has more than one member, refuse — they must transfer ownership or
 *     delete those workspaces first.
 *  2. Null out the assignee on every task assigned to the user. `task.assignee_id`
 *     cascades on user delete, so without this, deleting the account would also
 *     delete collaborators' tasks in workspaces the user does not own.
 *  3. Delete the user's solo workspaces (the only member is this user). This
 *     cascades their projects/tasks/columns and avoids orphaned workspaces.
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

    // Rule 1: block on co-owned workspaces.
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

    // Workspaces where this user is the only member.
    const soloWorkspaceIds = memberships
      .map((m) => m.workspaceId)
      .filter((id) => (countByWorkspace.get(id) ?? 1) === 1);

    await db.transaction(async (tx) => {
      // Rule 2: protect every assigned task from the assignee cascade.
      await tx
        .update(schema.taskTable)
        .set({ userId: null })
        .where(eq(schema.taskTable.userId, userId));

      // Rule 3: delete solo workspaces (cascades projects/tasks/columns/members).
      if (soloWorkspaceIds.length > 0) {
        await tx
          .delete(schema.workspaceTable)
          .where(inArray(schema.workspaceTable.id, soloWorkspaceIds));
      }
    });
  }
}

export default prepareAccountDeletion;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:integration -- delete-account`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/user/controllers/prepare-account-deletion.ts tests/api-integration/delete-account.test.ts
git commit -m "feat(api): add account-deletion guard controller"
```

---

## Task 2: Enable Better Auth deleteUser

**Files:**
- Modify: `apps/api/src/auth.ts` (the `user: { ... }` block, around lines 174-182)

- [ ] **Step 1: Wire the guard into Better Auth**

In [apps/api/src/auth.ts](apps/api/src/auth.ts), add the import near the other local imports (after line 45):

```ts
import prepareAccountDeletion from "./user/controllers/prepare-account-deletion";
```

Replace the existing `user` block:

```ts
  user: {
    additionalFields: {
      locale: {
        type: "string",
        input: true,
        required: false,
      },
    },
  },
```

with:

```ts
  user: {
    additionalFields: {
      locale: {
        type: "string",
        input: true,
        required: false,
      },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        await prepareAccountDeletion(user.id);
      },
    },
  },
```

- [ ] **Step 2: Verify the API type-checks and builds**

Run: `pnpm --filter @kaneo/api build`
Expected: build succeeds with no type errors.

- [ ] **Step 3: Add an integration test for the HTTP delete path**

Append to `tests/api-integration/delete-account.test.ts` a test that drives the endpoint end-to-end. The delete route is exposed by Better Auth at `POST /api/auth/delete-user`. Use the existing auth-session mock helper:

```ts
import { mockAuthenticatedSession } from "./helpers/auth";
import { createApp } from "../../apps/api/src/index";

it("removes the user row via the delete-user endpoint for a solo account", async () => {
  const owner = await createWorkspaceMember({ role: "owner" });
  mockAuthenticatedSession(owner.user);
  const { app } = createApp();

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
```

> Note: If Better Auth requires a verification callback or returns a non-2xx for the mocked session, adjust the assertion to confirm the guard ran (e.g., assert the block message for a co-owned workspace). The guard itself is fully covered by Task 1; this test guards the wiring.

- [ ] **Step 4: Run the integration test**

Run: `pnpm test:integration -- delete-account`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth.ts tests/api-integration/delete-account.test.ts
git commit -m "feat(api): enable Better Auth deleteUser with ownership guard"
```

---

## Task 3: Danger zone UI + delete dialog

**Files:**
- Modify: `apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/information.tsx`

This page already imports `useTranslation`, `toast`, `Separator`, and uses `useAuth()`. Confirm the available UI primitives first.

- [ ] **Step 1: Confirm the AlertDialog and Button primitives exist**

Run: `ls apps/web/src/components/ui/alert-dialog.tsx apps/web/src/components/ui/button.tsx`
Expected: both files exist. Open `alert-dialog.tsx` and note the exported names (commonly `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`, `AlertDialogAction`). Use the names this file actually exports in the JSX below.

- [ ] **Step 2: Add imports to information.tsx**

At the top of [information.tsx](apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/information.tsx), add:

```ts
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
```

(`useState` is added to the existing React import; `useTranslation`, `toast` are already imported.)

- [ ] **Step 3: Add delete state + handler inside `RouteComponent`**

After the existing hook declarations in `RouteComponent` (e.g. after `const { mutateAsync: updateProfile } = useUpdateUserProfile();`):

```ts
const [isDeleteOpen, setIsDeleteOpen] = useState(false);
const [isDeleting, setIsDeleting] = useState(false);

const handleDeleteAccount = async () => {
  setIsDeleting(true);
  try {
    const { error } = await authClient.deleteUser();
    if (error) {
      throw new Error(
        error.message || t("settings:informationPage.dangerZone.deleteError"),
      );
    }
    window.location.href = "/auth/sign-in";
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : t("settings:informationPage.dangerZone.deleteError"),
    );
    setIsDeleting(false);
    setIsDeleteOpen(false);
  }
};
```

> If `authClient.deleteUser` is not typed/available, confirm the client picks it up from the server config (no extra client plugin is required for `deleteUser`). If TypeScript can't see it, cast via `authClient as typeof authClient & { deleteUser: () => Promise<{ error: { message?: string } | null }> }`.

- [ ] **Step 4: Render the Danger zone section**

Inside the returned JSX, after the closing `</div>` of the profile `space-y-6` block but still inside `<div className="max-w-4xl mx-auto space-y-8">`, add:

```tsx
<div className="space-y-6">
  <div className="space-y-1">
    <h2 className="text-md font-medium text-destructive">
      {t("settings:informationPage.dangerZone.title")}
    </h2>
    <p className="text-xs text-muted-foreground">
      {t("settings:informationPage.dangerZone.subtitle")}
    </p>
  </div>

  <div className="flex items-center justify-between border border-destructive/40 rounded-md p-4 bg-destructive/5">
    <div className="space-y-0.5">
      <p className="text-sm font-medium">
        {t("settings:informationPage.dangerZone.deleteTitle")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("settings:informationPage.dangerZone.deleteDescription")}
      </p>
    </div>
    <Button
      variant="destructive"
      size="sm"
      onClick={() => setIsDeleteOpen(true)}
    >
      {t("settings:informationPage.dangerZone.deleteButton")}
    </Button>
  </div>
</div>

<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        {t("settings:informationPage.dangerZone.confirmTitle")}
      </AlertDialogTitle>
      <AlertDialogDescription>
        {t("settings:informationPage.dangerZone.confirmDescription")}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel disabled={isDeleting}>
        {t("common:actions.cancel")}
      </AlertDialogCancel>
      <AlertDialogAction
        onClick={(e) => {
          e.preventDefault();
          handleDeleteAccount();
        }}
        disabled={isDeleting}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {t("settings:informationPage.dangerZone.confirmButton")}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 5: Verify lint + build**

Run: `pnpm --filter @kaneo/web lint && pnpm --filter @kaneo/web build`
Expected: no lint errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/information.tsx
git commit -m "feat(web): add delete-account danger zone to account settings"
```

---

## Task 4: i18n strings (English + German)

**Files:**
- Modify: the web `settings` translation namespace (and `common` if `actions.cancel` is missing).

- [ ] **Step 1: Locate the settings namespace files**

Run: `ls apps/web/src/**/locales/**/settings.json` (or search): the project ships English + German.
Run: `rg -l "informationPage" apps/web/src` to find the exact files that hold the `settings` namespace.

- [ ] **Step 2: Add the Danger-zone keys to the English settings namespace**

Under `informationPage` add:

```json
"dangerZone": {
  "title": "Danger zone",
  "subtitle": "Irreversible actions for your account.",
  "deleteTitle": "Delete account",
  "deleteDescription": "Permanently delete your account and personal data.",
  "deleteButton": "Delete account",
  "confirmTitle": "Delete your account?",
  "confirmDescription": "This permanently deletes your account and cannot be undone. Workspaces you solely own will also be deleted.",
  "confirmButton": "Delete account",
  "deleteError": "Could not delete your account. Please try again."
}
```

- [ ] **Step 3: Add the same keys to the German settings namespace**

```json
"dangerZone": {
  "title": "Gefahrenzone",
  "subtitle": "Unwiderrufliche Aktionen für dein Konto.",
  "deleteTitle": "Konto löschen",
  "deleteDescription": "Lösche dein Konto und deine persönlichen Daten dauerhaft.",
  "deleteButton": "Konto löschen",
  "confirmTitle": "Konto wirklich löschen?",
  "confirmDescription": "Dadurch wird dein Konto dauerhaft gelöscht und kann nicht wiederhergestellt werden. Arbeitsbereiche, die nur dir gehören, werden ebenfalls gelöscht.",
  "confirmButton": "Konto löschen",
  "deleteError": "Konto konnte nicht gelöscht werden. Bitte versuche es erneut."
}
```

- [ ] **Step 4: Confirm `common:actions.cancel` exists**

Run: `rg "\"cancel\"" apps/web/src --glob "*common*"`
Expected: it already exists (used throughout, e.g. the create-task modal). If a key is missing, add it in both locales.

- [ ] **Step 5: Verify build + run the app manually**

Run: `pnpm --filter @kaneo/web build`
Then manually: open Settings → Account → Information, confirm the Danger zone renders, the dialog opens, Cancel closes it, and (in a throwaway DB) Delete signs you out.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add danger-zone i18n strings (en/de)"
```

---

## Self-Review notes

- **Spec coverage:** block-on-co-owned (Task 1 rule 1), solo-workspace deletion (rule 3), assignee-cascade mitigation (rule 2), simple confirm dialog (Task 3), enable Better Auth deleteUser (Task 2), i18n en/de (Task 4). All covered.
- **No schema migration** — the assignee FK is intentionally left as cascade; we unassign before delete.
- **Type consistency:** the guard is `prepareAccountDeletion(userId: string): Promise<void>`, imported as a default export in both Task 1 test and Task 2 wiring.
