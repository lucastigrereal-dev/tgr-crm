/** Frase única do prazo de destruição do papel (aviso assinado, rodapé da folha e custódia contam da mesma base: o dia da impressão). */
export function paperDestroyPromise(destroyDeadlineDays: number) {
  const days = Number.isFinite(destroyDeadlineDays) && destroyDeadlineDays > 0 ? Math.floor(destroyDeadlineDays) : 0;
  if (days === 0) return "no fim do dia em que é impressa";
  return `em até ${days} ${days === 1 ? "dia" : "dias"} depois do dia em que é impressa`;
}
