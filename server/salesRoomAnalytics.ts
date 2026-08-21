export type ConversionCapture = {
  id: number;
  createdAt: Date;
  scheduledAt: Date | null;
  resortId?: number | null;
  salesRoom?: string | null;
  campaignId: number | null;
  promoterId: number | null;
  linerId: number | null;
  closerId: number | null;
  presentationStatus: "captured" | "scheduled" | "checked_in" | "presented" | "no_tour" | "closed";
  checkedInAt: Date | null;
  presentationStartedAt: Date | null;
  opportunityStage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost" | null;
};

export type ConversionMetrics = {
  captures: number;
  scheduled: number;
  arrivals: number;
  presentations: number;
  completed: number;
  noTours: number;
  wins: number;
  arrivalRate: number;
  tourRate: number;
  closeRate: number;
  noTourRate: number;
};

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

function hasScheduledActivity(capture: ConversionCapture) {
  return capture.presentationStatus !== "captured" || Boolean(capture.scheduledAt);
}

export function calculateConversionMetrics(captures: ConversionCapture[]): ConversionMetrics {
  const scheduled = captures.filter(hasScheduledActivity);
  const arrivals = captures.filter(capture => Boolean(capture.checkedInAt));
  const presentations = captures.filter(capture => Boolean(capture.presentationStartedAt));
  const completed = captures.filter(capture => capture.presentationStatus === "closed");
  const noTours = captures.filter(capture => capture.presentationStatus === "no_tour");
  const wins = captures.filter(capture => capture.opportunityStage === "won");
  return {
    captures: captures.length,
    scheduled: scheduled.length,
    arrivals: arrivals.length,
    presentations: presentations.length,
    completed: completed.length,
    noTours: noTours.length,
    wins: wins.length,
    arrivalRate: ratio(arrivals.length, scheduled.length),
    tourRate: ratio(presentations.length, arrivals.length),
    closeRate: ratio(wins.length, presentations.length),
    noTourRate: ratio(noTours.length, scheduled.length),
  };
}

export type ConversionDimension = "campaign" | "promoter" | "liner" | "closer";
export type ConversionBreakdown = ConversionMetrics & { id: number | null; label: string };

export function buildConversionBreakdown(input: { captures: ConversionCapture[]; dimension: ConversionDimension; names: { campaigns: Map<number, string>; users: Map<number, string> } }) {
  const keyOf = (capture: ConversionCapture) => input.dimension === "campaign" ? capture.campaignId : input.dimension === "promoter" ? capture.promoterId : input.dimension === "liner" ? capture.linerId : capture.closerId;
  const labelOf = (id: number | null) => {
    if (id === null) return "Não atribuído";
    return input.dimension === "campaign" ? input.names.campaigns.get(id) ?? `Campanha #${id}` : input.names.users.get(id) ?? `Usuário #${id}`;
  };
  const buckets = new Map<number | null, ConversionCapture[]>();
  input.captures.forEach(capture => { const key = keyOf(capture); buckets.set(key, [...(buckets.get(key) ?? []), capture]); });
  return Array.from(buckets.entries()).map(([id, rows]) => ({ id, label: labelOf(id), ...calculateConversionMetrics(rows) })).sort((left, right) => right.captures - left.captures || left.label.localeCompare(right.label, "pt-BR"));
}

export function filterConversionCaptures(captures: ConversionCapture[], start: Date, end: Date, campaignId?: number, resortId?: number, salesRoom?: string) {
  return captures.filter(capture => {
    const reference = capture.scheduledAt ?? capture.createdAt;
    return reference >= start && reference < end && (!campaignId || capture.campaignId === campaignId) && (!resortId || capture.resortId === resortId) && (!salesRoom || capture.salesRoom === salesRoom);
  });
}
