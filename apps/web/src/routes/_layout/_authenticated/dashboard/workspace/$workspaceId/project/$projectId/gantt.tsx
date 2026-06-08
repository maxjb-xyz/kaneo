import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import ProjectLayout from "@/components/common/project-layout";
import { GanttView } from "@/components/gantt/gantt-view";
import PageTitle from "@/components/page-title";
import { useGetTasks } from "@/hooks/queries/task/use-get-tasks";

type GanttSearchParams = {
  taskId?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/gantt",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): GanttSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId, workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const { data: project } = useGetTasks(projectId);

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="gantt"
    >
      <PageTitle
        title={t("tasks:gantt.pageTitle", { name: project?.name })}
        hideAppName
      />
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
