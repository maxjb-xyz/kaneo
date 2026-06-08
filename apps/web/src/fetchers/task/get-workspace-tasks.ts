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
