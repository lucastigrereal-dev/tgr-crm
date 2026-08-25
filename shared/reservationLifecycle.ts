export type ReservationStatus = "pending" | "confirmed" | "checked_in" | "completed" | "cancelled";
export type WaitlistStatus = "waiting" | "offered" | "confirmed" | "expired" | "cancelled";

const reservationTransitions: Record<ReservationStatus, readonly ReservationStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled"],
  checked_in: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const waitlistTransitions: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
  waiting: ["offered", "expired", "cancelled"],
  offered: ["confirmed", "expired", "cancelled"],
  confirmed: [],
  expired: [],
  cancelled: [],
};

export function canTransitionReservationStatus(from: ReservationStatus, to: ReservationStatus): boolean {
  return from === to || reservationTransitions[from].includes(to);
}

export function canTransitionWaitlistStatus(from: WaitlistStatus, to: WaitlistStatus): boolean {
  return from === to || waitlistTransitions[from].includes(to);
}
