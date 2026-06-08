import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import AllTasksLayout from "@/components/common/all-tasks-layout";
import { GanttView } from "@/components/gantt/gantt-view";
import PageTitle from "@/components/page-title";
import { useGetWorkspaceTasks } from "@/hooks/queries/task/use-get-workspace-tasks";
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
      <PageTitle
        title={t("navigation:sidebar.allTasks", { defaultValue: "All Tasks" })}
        hideAppName
      />
      <GanttView
        project={data as unknown as ProjectWithTasks | undefined}
        workspaceId={workspaceId}
        taskId={taskId}
        onOpenTask={(id) =>
          navigate({ to: ".", search: { taskId: id }, replace: true })
        }
        onCloseTask={() => navigate({ to: ".", search: {}, replace: true })}
      />
    </AllTasksLayout>
  );
}
