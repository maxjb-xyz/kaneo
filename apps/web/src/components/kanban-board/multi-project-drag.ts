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
 * is its index among same-project tasks only, preserving visual order and
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
