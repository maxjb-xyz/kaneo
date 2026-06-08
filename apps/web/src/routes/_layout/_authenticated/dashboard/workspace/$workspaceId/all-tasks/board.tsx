import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BoardToolbar from "@/components/board/board-toolbar";
import AllTasksLayout from "@/components/common/all-tasks-layout";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import PageTitle from "@/components/page-title";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { Button } from "@/components/ui/button";
import useGetLabelsByWorkspace from "@/hooks/queries/label/use-get-labels-by-workspace";
import { useGetWorkspaceTasks } from "@/hooks/queries/task/use-get-workspace-tasks";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import type { SortConfig } from "@/lib/sort-tasks";
import { sortTasks } from "@/lib/sort-tasks";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type { ProjectWithTasks } from "@/types/project";

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
  const [sort, setSort] = useState<SortConfig>({
    field: "position",
    direction: "asc",
  });
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    if (data) {
      setLocal(data as unknown as ProjectWithTasks);
    }
  }, [data]);

  const projectColumns = (
    data as
      | (ProjectWithTasks & { projectColumns?: Record<string, string[]> })
      | undefined
  )?.projectColumns;

  const {
    filters,
    updateFilter,
    updateLabelFilter,
    filteredProject,
    hasActiveFilters,
    clearFilters,
  } = useTaskFiltersWithLabelsSupport(local, undefined, "");

  const sortedProject = useMemo(() => {
    if (!filteredProject || sort.field === "position") return filteredProject;
    return {
      ...filteredProject,
      columns: filteredProject.columns.map((column) => ({
        ...column,
        tasks: sortTasks(column.tasks, sort),
      })),
    };
  }, [filteredProject, sort]);

  return (
    <AllTasksLayout
      workspaceId={workspaceId}
      activeView="board"
      headerActions={
        <Button
          variant="outline"
          size="xs"
          className="gap-1"
          onClick={() => setIsCreateOpen(true)}
        >
          <Plus className="w-3 h-3" />
          {t("workspace:projects.createTask", { defaultValue: "New task" })}
        </Button>
      }
    >
      <PageTitle
        title={t("navigation:sidebar.allTasks", { defaultValue: "All Tasks" })}
      />
      <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
        <BoardToolbar
          project={local ?? undefined}
          filters={filters}
          updateFilter={updateFilter}
          updateLabelFilter={updateLabelFilter}
          clearFilters={clearFilters}
          hasActiveFilters={hasActiveFilters}
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
        <CreateTaskModal
          open={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          selectableProject
        />
      </div>
    </AllTasksLayout>
  );
}
