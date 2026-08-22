export type CaptureProfile = {
  id: number;
  createdAt: Date;
  customerName: string;
  customerDocumentNumber: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  city: string | null;
  state: string | null;
  resortId: number | null;
  resortName: string | null;
  promoterId: number | null;
  qualifierId: number | null;
  linerId: number | null;
  closerId: number | null;
  roomManagerId: number | null;
  campaignId: number | null;
  campaignName: string | null;
  salesRoom: string | null;
  captureLocation: string | null;
  lodgingLocation: string | null;
  transportation: string | null;
  isPasserby: boolean;
  scheduledAt: Date | null;
  presentationStatus: "captured" | "scheduled" | "checked_in" | "presented" | "no_tour" | "closed";
  qualificationStatus: "pending" | "qualified" | "disqualified";
  partnerName: string | null;
  partnerAge: number | null;
  partnerProfession: string | null;
  relationshipStatus: string | null;
  relationshipYears: number | null;
  relationshipMonths: number | null;
  childrenCount: number;
  childrenNames: string | null;
  averageIncome: number | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  hasCreditCard: boolean | null;
  creditCardBrands: string | null;
  acceptsCheque: boolean | null;
  ownsHome: boolean | null;
  ownsPropertyInCity: boolean | null;
  travelWeeksPerYear: number | null;
  usualTravelSeason: string | null;
  dreamTrips: string | null;
  lastTrip: string | null;
  averageHotelSpend: number | null;
  nextFamilyTrip: string | null;
  socialNetworks: string | null;
  giftDescription: string | null;
  qualificationReason: string | null;
  notes: string | null;
  opportunityStage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost" | null;
  checkedInAt: Date | null;
  presentationStartedAt: Date | null;
};

export type CaptureProfileCompleteness = {
  completed: number;
  total: number;
  percent: number;
  missing: string[];
};

const text = (value: string | null | undefined) => Boolean(value?.trim());
const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);
const boolean = (value: boolean | null | undefined) => typeof value === "boolean";

export function getProfileCompleteness(profile: CaptureProfile): CaptureProfileCompleteness {
  const checks: Array<[string, boolean]> = [
    ["Nome do titular", text(profile.customerName)],
    ["Documento", text(profile.customerDocumentNumber)],
    ["Telefone", text(profile.customerPhone)],
    ["E-mail", text(profile.customerEmail)],
    ["Cidade", text(profile.city)],
    ["UF", text(profile.state)],
    ["Empreendimento", Boolean(profile.resortId)],
    ["Sala de vendas", text(profile.salesRoom)],
    ["Local de captação", text(profile.captureLocation)],
    ["Hospedagem", text(profile.lodgingLocation)],
    ["Transporte", text(profile.transportation)],
    ["Campanha", Boolean(profile.campaignId)],
    ["Captador", Boolean(profile.promoterId) || profile.isPasserby],
    ["Agendamento ou atendimento", Boolean(profile.scheduledAt || profile.checkedInAt || profile.presentationStartedAt)],
    ["Qualificação", profile.qualificationStatus !== "pending"],
    ["Nome do cônjuge", text(profile.partnerName)],
    ["Idade do cônjuge", number(profile.partnerAge)],
    ["Profissão do cônjuge", text(profile.partnerProfession)],
    ["Relacionamento", text(profile.relationshipStatus)],
    ["Tempo de relacionamento", number(profile.relationshipYears) || number(profile.relationshipMonths)],
    ["Filhos", number(profile.childrenCount)],
    ["Renda familiar", number(profile.averageIncome)],
    ["Veículo", text(profile.vehicleBrand) || text(profile.vehicleModel)],
    ["Ano do veículo", number(profile.vehicleYear)],
    ["Cartão", boolean(profile.hasCreditCard)],
    ["Bandeiras de cartão", profile.hasCreditCard === false || text(profile.creditCardBrands)],
    ["Cheque", boolean(profile.acceptsCheque)],
    ["Casa própria", boolean(profile.ownsHome)],
    ["Imóvel na cidade", boolean(profile.ownsPropertyInCity)],
    ["Semanas de viagem", number(profile.travelWeeksPerYear)],
    ["Época de viagem", text(profile.usualTravelSeason)],
    ["Viagens dos sonhos", text(profile.dreamTrips)],
    ["Última viagem", text(profile.lastTrip)],
    ["Gasto médio de hotel", number(profile.averageHotelSpend)],
    ["Próxima viagem", text(profile.nextFamilyTrip)],
    ["Redes sociais", text(profile.socialNetworks)],
    ["Brinde", text(profile.giftDescription)],
  ];
  const missing = checks.filter(([, valid]) => !valid).map(([label]) => label);
  return { completed: checks.length - missing.length, total: checks.length, percent: Math.round(((checks.length - missing.length) / checks.length) * 100), missing };
}

export type CaptureProfileAnalytics = {
  total: number;
  qualified: number;
  arrivals: number;
  presentations: number;
  wins: number;
  noTours: number;
  averageIncome: number;
  averageHotelSpend: number;
  averageChildren: number;
  averageCompleteness: number;
  completeProfiles: number;
  byVehicleBrand: Array<{ label: string; count: number; qualified: number; wins: number }>;
  byCity: Array<{ label: string; count: number; qualified: number; wins: number }>;
  byChildrenCount: Array<{ label: string; count: number; qualified: number; wins: number }>;
  byQualification: Array<{ label: string; count: number }>;
  byTravelSeason: Array<{ label: string; count: number }>;
};

type ProfileBucket = { label: string; count: number; qualified: number; wins: number };

function bucket(rows: CaptureProfile[], keyOf: (row: CaptureProfile) => string | null | undefined): ProfileBucket[] {
  const map = new Map<string, { count: number; qualified: number; wins: number }>();
  rows.forEach(row => {
    const label = keyOf(row)?.trim() || "Não informado";
    const current = map.get(label) || { count: 0, qualified: 0, wins: 0 };
    current.count += 1;
    if (row.qualificationStatus === "qualified") current.qualified += 1;
    if (row.opportunityStage === "won") current.wins += 1;
    map.set(label, current);
  });
  return Array.from(map, ([label, values]) => ({ label, ...values })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "pt-BR"));
}

export function buildCaptureProfileAnalytics(rows: CaptureProfile[]): CaptureProfileAnalytics {
  const completeness = rows.map(getProfileCompleteness);
  const sum = (values: Array<number | null | undefined>) => values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
  return {
    total: rows.length,
    qualified: rows.filter(row => row.qualificationStatus === "qualified").length,
    arrivals: rows.filter(row => Boolean(row.checkedInAt)).length,
    presentations: rows.filter(row => Boolean(row.presentationStartedAt)).length,
    wins: rows.filter(row => row.opportunityStage === "won").length,
    noTours: rows.filter(row => row.presentationStatus === "no_tour").length,
    averageIncome: rows.length ? Math.round((sum(rows.map(row => row.averageIncome)) / rows.filter(row => number(row.averageIncome)).length || 0) * 100) / 100 : 0,
    averageHotelSpend: rows.length ? Math.round((sum(rows.map(row => row.averageHotelSpend)) / rows.filter(row => number(row.averageHotelSpend)).length || 0) * 100) / 100 : 0,
    averageChildren: rows.length ? Math.round((sum(rows.map(row => row.childrenCount)) / rows.length) * 100) / 100 : 0,
    averageCompleteness: completeness.length ? Math.round((sum(completeness.map(item => item.percent)) / completeness.length) * 100) / 100 : 0,
    completeProfiles: completeness.filter(item => item.percent === 100).length,
    byVehicleBrand: bucket(rows, row => row.vehicleBrand),
    byCity: bucket(rows, row => row.city),
    byChildrenCount: bucket(rows, row => String(row.childrenCount)),
    byQualification: bucket(rows, row => row.qualificationStatus).map(({ label, count }) => ({ label, count })),
    byTravelSeason: bucket(rows, row => row.usualTravelSeason).map(({ label, count }) => ({ label, count })),
  };
}

export function profileSearchText(profile: CaptureProfile) {
  return [
    profile.customerName, profile.customerDocumentNumber, profile.customerEmail, profile.customerPhone, profile.city, profile.state,
    profile.resortName, profile.campaignName, profile.salesRoom, profile.captureLocation, profile.lodgingLocation, profile.transportation,
    profile.partnerName, profile.partnerProfession, profile.relationshipStatus, profile.childrenNames, profile.vehicleBrand, profile.vehicleModel,
    profile.creditCardBrands, profile.usualTravelSeason, profile.dreamTrips, profile.lastTrip, profile.nextFamilyTrip, profile.socialNetworks,
    profile.giftDescription, profile.qualificationReason, profile.notes,
  ].filter(Boolean).join(" ").toLocaleLowerCase("pt-BR");
}
