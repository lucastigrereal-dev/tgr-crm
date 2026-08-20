export type CaptureReadinessInput = {
  customerName?: string | null;
  phone?: string | null;
  city?: string | null;
  promoterId?: number | null;
  captureLocation?: string | null;
  averageIncome?: number | null;
  travelWeeksPerYear?: number | null;
  qualificationStatus?: "pending" | "qualified" | "disqualified";
};

export function getCaptureReadiness(input: CaptureReadinessInput) {
  const checks = [
    ["Nome do titular", Boolean(input.customerName?.trim())],
    ["Telefone", Boolean(input.phone?.trim())],
    ["Cidade", Boolean(input.city?.trim())],
    ["Captador", Boolean(input.promoterId)],
    ["Local de captação", Boolean(input.captureLocation?.trim())],
    ["Renda familiar", typeof input.averageIncome === "number" && input.averageIncome > 0],
    ["Perfil de viagem", typeof input.travelWeeksPerYear === "number" && input.travelWeeksPerYear > 0],
    ["Qualificação", input.qualificationStatus !== "pending"],
  ] as const;
  const missing = checks.filter(([, valid]) => !valid).map(([label]) => label);
  return { completed: checks.length - missing.length, total: checks.length, percent: Math.round(((checks.length - missing.length) / checks.length) * 100), missing };
}

export function getCaptureAppointmentPlan(input: { customerName: string; scheduledAt?: Date | null; salesRoom?: string | null }) {
  if (!input.scheduledAt) return { presentationStatus: "captured" as const, task: null };
  const room = input.salesRoom?.trim() ? ` · ${input.salesRoom.trim()}` : "";
  return {
    presentationStatus: "scheduled" as const,
    task: {
      title: `Captação · ${input.customerName} · atendimento`,
      description: `Atendimento de captação agendado${room}. Confirmar presença, registrar apresentação e atualizar a oportunidade.`,
      dueAt: input.scheduledAt,
      reminderAt: input.scheduledAt,
    },
  };
}
