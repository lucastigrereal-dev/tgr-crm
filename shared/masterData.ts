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

/**
 * Valores gravados pelo próprio sistema (não por gente): marcam a origem da ficha e valem mesmo com a lista fechada.
 * A ficha criada pela formalização automática do Sales Command usa "Sales Command" como local de captação.
 */
export const reservedMasterDataValues: Record<MasterDataField, readonly string[]> = {
  captureLocation: ["Sales Command"],
  transportation: [],
  vehicleBrand: [],
  partnerProfession: [],
};
export const isReservedMasterDataValue = (field: MasterDataField, value: string) => reservedMasterDataValues[field].some(reserved => masterDataKey(reserved) === masterDataKey(value));

/** Teto de opções ativas por campo: a lista inteira sempre cabe numa leitura, então a tela mostra tudo o que o servidor aceita. */
export const MAX_ACTIVE_OPTIONS_PER_FIELD = 2000;
