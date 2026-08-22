export type SalesRoomRealtimeEvent = {
  topic: "sales-room";
  type: "capture.created" | "capture.checked_in" | "capture.room.assigned" | "capture.presentation.started" | "capture.presentation.ended" | "capture.no_tour" | "capture.status.updated";
  captureId?: number;
  salesRoom?: string | null;
  occurredAt: string;
};

type Subscriber = (event: SalesRoomRealtimeEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribeSalesRoom(subscriber: Subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function publishSalesRoomEvent(event: Omit<SalesRoomRealtimeEvent, "topic" | "occurredAt">) {
  const payload: SalesRoomRealtimeEvent = {
    topic: "sales-room",
    occurredAt: new Date().toISOString(),
    ...event,
  };
  subscribers.forEach(subscriber => {
    try {
      subscriber(payload);
    } catch {
      // Um consumidor desconectado não pode interromper o fluxo operacional.
    }
  });
}
