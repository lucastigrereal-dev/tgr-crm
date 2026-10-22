import { describe, expect, it } from "vitest";
import { partitionRoomQueue, roomStageOf } from "./salesRoomStages";

describe("colunas da sala de vendas", () => {
  it("captured sem data espera na coluna scheduled; captured com data não aparece", () => {
    expect(roomStageOf({ presentationStatus: "captured", scheduledAt: null })).toBe("scheduled");
    expect(roomStageOf({ presentationStatus: "captured", scheduledAt: new Date() })).toBeNull();
  });
  it("particiona e nenhum casal da fila fica sem coluna", () => {
    const items = [
      { capture: { id: 1, presentationStatus: "scheduled", scheduledAt: new Date() } },
      { capture: { id: 2, presentationStatus: "captured", scheduledAt: null } },
      { capture: { id: 3, presentationStatus: "checked_in", scheduledAt: null } },
      { capture: { id: 4, presentationStatus: "presented", scheduledAt: new Date() } },
    ];
    const stages = partitionRoomQueue(items);
    expect(stages.scheduled.map(i => i.capture.id)).toEqual([1, 2]);
    expect(stages.checked_in.map(i => i.capture.id)).toEqual([3]);
    expect(stages.presented.map(i => i.capture.id)).toEqual([4]);
    expect(stages.scheduled.length + stages.checked_in.length + stages.presented.length).toBe(items.length);
  });
});
