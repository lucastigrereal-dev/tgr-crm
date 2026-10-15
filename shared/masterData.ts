/** Campos da ficha de captação que podem ter dicionário fechado (TSE #25). */
export const masterDataFields = ["captureLocation", "transportation", "vehicleBrand", "partnerProfession"] as const;
export type MasterDataField = (typeof masterDataFields)[number];

export const masterDataFieldLabel: Record<MasterDataField, string> = {
  captureLocation: "Local de captação",
  transportation: "Transporte",
  vehicleBrand: "Marca do veículo",
  partnerProfession: "Profissão do cônjuge",
};

/** Tamanho máximo de cada campo na ficha de captação: uma opção maior que isso nunca poderia ser escolhida. */
export const masterDataMaxLength: Record<MasterDataField, number> = { captureLocation: 180, transportation: 100, vehicleBrand: 100, partnerProfession: 120 };

/** Chave de comparação: sem acento, sem diferença de maiúscula e com espaços únicos ("Olímpia " = "olimpia"). */
export function masterDataKey(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

/**
 * Valores gravados só pelo próprio sistema: marcam a origem da ficha. A formalização automática do Sales Command grava
 * "Sales Command" como local de captação direto no banco; a captação manual não pode usar esse valor, e ele fica fora
 * da cobertura e da importação do dicionário.
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
/** Teto de opções guardadas por campo, ativas ou não: a tela de administração sempre mostra o histórico inteiro. */
export const MAX_TOTAL_OPTIONS_PER_FIELD = 5000;
