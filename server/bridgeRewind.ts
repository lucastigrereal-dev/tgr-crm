/**
 * Pedido de releitura das pontes (CRM-A25). As pontes andam por um cursor em memória e só releem, sem reiniciar, os eventos
 * recentes (janela de 15 min). Para o botão "reenviar" do painel valer para um recusado antigo, o painel registra aqui o menor id
 * a reler e a ponte dona do recibo (chave = prefixo do recibo) recua o cursor no início do próximo tick. Os já entregues não são
 * reenviados: só o que está sem recibo entra na releitura.
 */
const pending = new Map<string, number>();

export function requestBridgeRewind(receiptPrefix: string, eventId: number) {
  pending.set(receiptPrefix, Math.min(pending.get(receiptPrefix) ?? Number.POSITIVE_INFINITY, eventId));
}

/** Entrega e limpa o pedido da ponte (nulo se não há). */
export function takeBridgeRewind(receiptPrefix: string): number | null {
  const value = pending.get(receiptPrefix);
  if (value === undefined) return null;
  pending.delete(receiptPrefix);
  return value;
}
