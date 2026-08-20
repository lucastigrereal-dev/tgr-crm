export const domainEventCatalog = {
  "customer.created": { aggregateType: "customer", description: "Associado criado." },
  "customer.updated": { aggregateType: "customer", description: "Cadastro do associado atualizado." },
  "customer.interaction.created": { aggregateType: "customer_interaction", description: "Interação com associado registrada." },
  "customer.document.uploaded": { aggregateType: "customer_document", description: "Documento do associado anexado." },
  "contract.created": { aggregateType: "contract", description: "Contrato e cronograma criados." },
  "contract.status.updated": { aggregateType: "contract", description: "Status contratual alterado." },
  "contract.document.uploaded": { aggregateType: "contract_document", description: "Documento contratual anexado." },
  "ownership.entitlement.created": { aggregateType: "ownership_entitlement", description: "Direito de uso criado." },
  "unit.maintenance.blocked": { aggregateType: "unit_maintenance_block", description: "Unidade bloqueada para manutenção." },
  "opportunity.created": { aggregateType: "opportunity", description: "Oportunidade comercial criada." },
  "opportunity.updated": { aggregateType: "opportunity", description: "Oportunidade comercial atualizada." },
  "proposal.created": { aggregateType: "proposal", description: "Proposta comercial criada." },
  "sales.playbook.created": { aggregateType: "sales_playbook", description: "Playbook comercial publicado." },
  "installment.renegotiation.proposed": { aggregateType: "installment_renegotiation", description: "Renegociação proposta." },
  "installment.paid": { aggregateType: "installment", description: "Parcela baixada." },
  "financial.entry.created": { aggregateType: "financial_transaction", description: "Lançamento financeiro criado." },
  "financial.entry.reconciled": { aggregateType: "financial_transaction", description: "Lançamento financeiro conciliado." },
  "financial.transfer.created": { aggregateType: "financial_transfer", description: "Repasse financeiro criado." },
} as const;

export type DomainEventName = keyof typeof domainEventCatalog;

export function isKnownDomainEvent(value: string): value is DomainEventName {
  return Object.prototype.hasOwnProperty.call(domainEventCatalog, value);
}

export function domainEventDefinition(name: DomainEventName) {
  return domainEventCatalog[name];
}
