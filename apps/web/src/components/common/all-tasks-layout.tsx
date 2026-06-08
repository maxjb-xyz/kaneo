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
                {t("navigation:sidebar.allTasks", {
                  defaultValue: "All Tasks",
                })}
              </span>
            </div>
            <div className="hidden h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-background p-0.5 sm:inline-flex">
              {tab(
                "backlog",
                <SquircleDashed className="size-3.5" />,
                "Backlog",
              )}
              {tab("board", <SquareKanban className="size-3.5" />, "Tasks")}
              {tab("gantt", <CalendarDays className="size-3.5" />, "Gantt")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {headerActions}
          </div>
        </div>
      </Layout.Header>
      <Layout.Content>{children}</Layout.Content>
    </Layout>
  );
}
