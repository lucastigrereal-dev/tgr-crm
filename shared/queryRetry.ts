// O QueryClient padrão do react-query repete consulta com erro 3x (espera 1s, 2s, 4s = ~7s) antes de mostrar o erro. Para resposta DEFINITIVA do servidor
// (não existe, sem permissão, pedido inválido) repetir só atrasa a tela: "Ficha não encontrada" levava ~7s para aparecer e o E2E (espera de 8s) oscilava.
const DEFINITIVE = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]);

export function retryUnlessDefinitive(failureCount: number, error: unknown, maxRetries = 3): boolean {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (typeof code === "string" && DEFINITIVE.has(code)) return false;
  return failureCount < maxRetries;
}
