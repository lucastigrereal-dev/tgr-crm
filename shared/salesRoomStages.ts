/** Colunas da Sala de vendas. Ficha legada sem data de visita ainda em "captured" espera na coluna "scheduled" (o check-in aceita captured). */
export type RoomStage = "scheduled" | "checked_in" | "presented";
export const ROOM_STAGES: readonly RoomStage[] = ["scheduled", "checked_in", "presented"];

export function roomStageOf(capture: { presentationStatus: string; scheduledAt?: Date | string | null }): RoomStage | null {
  if (capture.presentationStatus === "scheduled" || (capture.presentationStatus === "captured" && !capture.scheduledAt)) return "scheduled";
  if (capture.presentationStatus === "checked_in") return "checked_in";
  if (capture.presentationStatus === "presented") return "presented";
  return null;
}

export function partitionRoomQueue<T extends { capture: { presentationStatus: string; scheduledAt?: Date | string | null } }>(items: readonly T[]): Record<RoomStage, T[]> {
  const stages: Record<RoomStage, T[]> = { scheduled: [], checked_in: [], presented: [] };
  for (const item of items) { const stage = roomStageOf(item.capture); if (stage) stages[stage].push(item); }
  return stages;
}
