import { describe, expect, it } from "vitest";
import { canTransitionTaskStatus, taskPrimaryAction } from "./taskLifecycle";

describe("task lifecycle UI contract", () => {
  it("offers the only valid primary action for an open task", () => {
    expect(taskPrimaryAction("open")).toEqual({ label: "Iniciar", status: "in_progress" });
    expect(canTransitionTaskStatus("open", "done")).toBe(false);
    expect(canTransitionTaskStatus("open", "in_progress")).toBe(true);
  });

  it("offers completion only after the task is in progress", () => {
    expect(taskPrimaryAction("in_progress")).toEqual({ label: "Concluir", status: "done" });
    expect(canTransitionTaskStatus("in_progress", "done")).toBe(true);
  });

  it("does not offer a primary action for terminal states", () => {
    expect(taskPrimaryAction("done")).toBeNull();
    expect(taskPrimaryAction("cancelled")).toBeNull();
  });
});
