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
