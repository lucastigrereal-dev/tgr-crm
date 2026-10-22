import { and, eq, isNull } from "drizzle-orm";
import { resorts } from "../drizzle/schema";

/** Falha de mapeamento do projeto do Sales para um resort do CRM. Cada receptor traduz o código para a sua própria resposta. */
export class ResortResolutionError extends Error {
  constructor(readonly code: "PROJECT_NOT_MAPPED" | "PROJECT_MAPPING_CONFLICT", message: string) { super(message); this.name = "ResortResolutionError"; }
}

/**
 * Regra ÚNICA de mapeamento projeto -> resort (extraída da venda do Sales sem mudar o comportamento dela; usada também pelo receptor de atendimento):
 *  1. resort com a mesma externalKey; 2. senão, resort com o mesmo NOME; 3. nenhum => PROJECT_NOT_MAPPED.
 *  Resort achado pelo nome: sem chave => grava a chave do projeto; com OUTRA chave => PROJECT_MAPPING_CONFLICT (não retentável).
 * `strictNameOnKeyMatch` (padrão: a venda): chave igual com NOME diferente é conflito. O receptor de atendimento passa false: um projeto renomeado no Sales não deve
 * derrubar o atendimento já mapeado por chave.
 */
export async function resolveResortForProject(tx: any, project: { externalKey: string; name: string }, options: { strictNameOnKeyMatch?: boolean } = {}) {
  const strict = options.strictNameOnKeyMatch ?? true;
  const byKey = (await tx.select().from(resorts).where(eq(resorts.externalKey, project.externalKey)).limit(1).for("update"))[0];
  if (byKey) {
    if (strict && byKey.name !== project.name) throw new ResortResolutionError("PROJECT_MAPPING_CONFLICT", "Project external key is mapped to another resort name");
    return byKey;
  }
  const byName = (await tx.select().from(resorts).where(eq(resorts.name, project.name)).limit(1).for("update"))[0];
  if (!byName) throw new ResortResolutionError("PROJECT_NOT_MAPPED", "Sales Command project is not mapped to a CRM resort");
  if (byName.externalKey && byName.externalKey !== project.externalKey) throw new ResortResolutionError("PROJECT_MAPPING_CONFLICT", "CRM resort is already mapped to another Sales Command project");
  if (!byName.externalKey) {
    await tx.update(resorts).set({ externalKey: project.externalKey }).where(and(eq(resorts.id, byName.id), isNull(resorts.externalKey)));
  }
  return { ...byName, externalKey: project.externalKey };
}
