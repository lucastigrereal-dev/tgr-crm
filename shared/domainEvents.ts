export const domainEventCatalog = {
  "customer.created": { aggregateType: "customer", description: "Associado criado." },
  "customer.updated": { aggregateType: "customer", description: "Cadastro do associado atualizado." },
  "customer.interaction.created": { aggregateType: "customer_interaction", description: "Interação com associado registrada." },
  "customer.document.uploaded": { aggregateType: "customer_document", description: "Documento do associado anexado." },
  "contract.created": { aggregateType: "contract", description: "Contrato e cronograma criados." },
  "contract.status.updated": { aggregateType: "contract", description: "Status contratual alterado." },
  "contract.cancellation.requested": { aggregateType: "contract_cancellation_request", description: "Pedido de distrato registrado." },
  "contract.cancellation.decided": { aggregateType: "contract_cancellation_request", description: "Decisão de distrato registrada." },
  "contract.document.uploaded": { aggregateType: "contract_document", description: "Documento contratual anexado." },
  "contract.document.signed": { aggregateType: "contract_document", description: "Assinatura documental confirmada pela administração." },
  "ownership.entitlement.created": { aggregateType: "ownership_entitlement", description: "Direito de uso criado." },
  "unit.maintenance.blocked": { aggregateType: "unit_maintenance_block", description: "Unidade bloqueada para manutenção." },
  "opportunity.created": { aggregateType: "opportunity", description: "Oportunidade comercial criada." },
  "opportunity.updated": { aggregateType: "opportunity", description: "Oportunidade comercial atualizada." },
  "capture.created": { aggregateType: "capture", description: "Ficha de captação registrada." },
  "capture.status.updated": { aggregateType: "capture", description: "Status da ficha de captação atualizado." },
  "capture.checked_in": { aggregateType: "capture", description: "Chegada confirmada pela recepção." },
  "capture.room.assigned": { aggregateType: "capture", description: "Mesa e equipe de sala atribuídas." },
  "capture.presentation.started": { aggregateType: "capture", description: "Apresentação comercial iniciada." },
  "capture.presentation.ended": { aggregateType: "capture", description: "Apresentação comercial encerrada." },
  "capture.no_tour": { aggregateType: "capture", description: "Captação encerrada sem apresentação." },
  "proposal.created": { aggregateType: "proposal", description: "Proposta comercial criada." },
  "proposal.accepted": { aggregateType: "proposal", description: "Proposta comercial aceita, ainda sem validação de venda." },
  "sales.playbook.created": { aggregateType: "sales_playbook", description: "Playbook comercial publicado." },
  "installment.renegotiation.proposed": { aggregateType: "installment_renegotiation", description: "Renegociação proposta." },
  "installment.paid": { aggregateType: "installment", description: "Parcela baixada." },
  "commission.automatic.blocked": { aggregateType: "installment", description: "Comissão automática bloqueada por política incompleta." },
  "revenue_quality_ledger.synced": { aggregateType: "contract", description: "Fatos de qualidade de receita projetados de forma idempotente." },
  "financial.portfolio.assigned": { aggregateType: "financial_portfolio_assignment", description: "Responsável da carteira financeira atribuído." },
  "financial.entry.created": { aggregateType: "financial_transaction", description: "Lançamento financeiro criado." },
  "financial.billing.created": { aggregateType: "billing_record", description: "Cobrança financeira criada." },
  "financial.entry.reconciled": { aggregateType: "financial_transaction", description: "Lançamento financeiro conciliado." },
  "financial.transfer.created": { aggregateType: "financial_transfer", description: "Repasse financeiro criado." },
  "financial.transfer.paid": { aggregateType: "financial_transfer", description: "Repasse financeiro pago." },
  "ai.assistance.requested": { aggregateType: "customer", description: "Assistência de IA consultada com contexto permissionado." },
} as const;

export type DomainEventName = keyof typeof domainEventCatalog;

export function isKnownDomainEvent(value: string): value is DomainEventName {
  return Object.prototype.hasOwnProperty.call(domainEventCatalog, value);
}

export function domainEventDefinition(name: DomainEventName) {
  return domainEventCatalog[name];
}
