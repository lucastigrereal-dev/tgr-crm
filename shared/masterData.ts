/** Campos da ficha de captação que podem ter dicionário fechado (TSE #25). */
export const masterDataFields = ["captureLocation", "transportation", "vehicleBrand", "partnerProfession"] as const;
export type MasterDataField = (typeof masterDataFields)[number];

export const masterDataFieldLabel: Record<MasterDataField, string> = {
  captureLocation: "Local de captação",
  transportation: "Transporte",
  vehicleBrand: "Marca do veículo",
  partnerProfession: "Profissão do cônjuge",
};

/** Chave de comparação: sem acento, sem diferença de maiúscula e com espaços únicos ("Olímpia " = "olimpia"). */
export function masterDataKey(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}
