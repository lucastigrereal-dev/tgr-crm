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

