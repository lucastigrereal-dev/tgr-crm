export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in_progress", "cancelled"],
  in_progress: ["open", "done", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || taskTransitions[from].includes(to);
}

export type TaskPrimaryAction =
  | { label: "Iniciar"; status: "in_progress" }
  | { label: "Concluir"; status: "done" }
  | null;

export function taskPrimaryAction(status: TaskStatus): TaskPrimaryAction {
  if (status === "open") return { label: "Iniciar", status: "in_progress" };
  if (status === "in_progress") return { label: "Concluir", status: "done" };
  return null;
}

