export type PresentationStatus = "captured" | "scheduled" | "checked_in" | "presented" | "no_tour" | "closed";

export type ReceptionAction = "check_in" | "assign_table" | "start_presentation" | "end_presentation" | "mark_no_tour";

type CaptureRoomState = {
  presentationStatus: PresentationStatus;
  salesTable?: string | null;
  presentationStartedAt?: Date | null;
  presentationEndedAt?: Date | null;
};

const terminalStatuses: PresentationStatus[] = ["no_tour", "closed"];
export const activeRoomStatuses: PresentationStatus[] = ["scheduled", "checked_in", "presented"];

const presentationTransitions: Record<PresentationStatus, readonly PresentationStatus[]> = {
  captured: ["captured", "scheduled", "checked_in", "no_tour"],
  scheduled: ["scheduled", "checked_in", "no_tour"],
  checked_in: ["checked_in", "presented", "no_tour"],
  presented: ["presented", "closed"],
  no_tour: ["no_tour"],
  closed: ["closed"],
};

export function canTransitionPresentationStatus(current: PresentationStatus, next: PresentationStatus) {
  return presentationTransitions[current].includes(next);
}

type QueueCapture = {
  presentationStatus: PresentationStatus;
  scheduledAt: Date | null;
  /** Sem data de visita, vale o dia da criação da ficha. */
  createdAt?: Date | null;
  salesRoom: string | null;
};

export function filterReceptionQueue<T extends { capture: QueueCapture }>(rows: T[], input: { date: string; salesRoom?: string | null; includeCompleted?: boolean }) {
  const start = new Date(`${input.date}T00:00:00-03:00`);
  const end = new Date(`${input.date}T23:59:59.999-03:00`);
  const salesRoom = input.salesRoom?.trim();
  const when = (capture: QueueCapture) => capture.scheduledAt ?? capture.createdAt ?? null;
  return rows.filter(row => {
    const at = when(row.capture);
    if (!at || at < start || at >= end) return false;
    if (salesRoom && row.capture.salesRoom !== salesRoom) return false;
    // Ficha sem data ainda "captured" aguarda atendimento no dia da criação.
    const awaiting = !row.capture.scheduledAt && row.capture.presentationStatus === "captured";
    return input.includeCompleted || awaiting || activeRoomStatuses.includes(row.capture.presentationStatus);
  }).sort((left, right) => when(left.capture)!.getTime() - when(right.capture)!.getTime());
}

export function assertReceptionAction(state: CaptureRoomState, action: ReceptionAction) {
  if (terminalStatuses.includes(state.presentationStatus)) {
    throw new Error("Esta ficha já está encerrada e não pode voltar para a fila operacional.");
  }

  if (action === "check_in" && !["captured", "scheduled"].includes(state.presentationStatus)) {
    throw new Error("A chegada só pode ser registrada para uma captação aguardando atendimento.");
  }

  if (action === "assign_table" && state.presentationStatus === "presented" && state.presentationEndedAt) {
    throw new Error("A apresentação já foi encerrada; reatribua uma nova captação, não reescreva o histórico.");
  }

  if (action === "start_presentation") {
    if (state.presentationStatus !== "checked_in") {
      throw new Error("O tour só pode começar depois do check-in da recepção.");
    }
    if (!state.salesTable?.trim()) {
      throw new Error("Atribua uma mesa antes de iniciar a apresentação.");
    }
  }

  if (action === "end_presentation") {
    if (state.presentationStatus !== "presented" || !state.presentationStartedAt) {
      throw new Error("Não existe apresentação em andamento para encerrar.");
    }
    if (state.presentationEndedAt) {
      throw new Error("Esta apresentação já foi encerrada; o relógio não anda para trás.");
    }
  }

  if (action === "mark_no_tour" && state.presentationStatus === "presented") {
    throw new Error("Uma apresentação já iniciada deve ser encerrada, não marcada como sem-tour.");
  }
}

export function tourDurationMinutes(startedAt: Date | null, endedAt: Date | null, now = new Date()) {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor(((endedAt ?? now).getTime() - startedAt.getTime()) / 60000));
}
