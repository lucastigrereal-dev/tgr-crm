import { describe, expect, it } from "vitest";
import { publishSalesRoomEvent, subscribeSalesRoom } from "./realtime";

describe("sales room realtime bus", () => {
  it("entrega eventos e permite cancelar a assinatura", () => {
    const received: string[] = [];
    const unsubscribe = subscribeSalesRoom(event => received.push(`${event.type}:${event.captureId}`));
    publishSalesRoomEvent({ type: "capture.checked_in", captureId: 7, salesRoom: "Sala A" });
    unsubscribe();
    publishSalesRoomEvent({ type: "capture.room.assigned", captureId: 7, salesRoom: "Sala A" });
    expect(received).toEqual(["capture.checked_in:7"]);
  });
});
