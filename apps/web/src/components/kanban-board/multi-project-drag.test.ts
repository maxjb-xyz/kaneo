import { describe, expect, it } from "vitest";
import type Task from "@/types/task";
import {
  isValidDropTarget,
  reconcilePositionsByProject,
} from "./multi-project-drag";

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
