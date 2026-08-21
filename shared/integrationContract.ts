import { DomainEventName } from "./domainEvents";

export const integrationContractVersion = "tse.events.v1";

const allowedPayloadFields: Record<DomainEventName, readonly string[]> = {
  "customer.created": ["status", "acquisitionSource"], "customer.updated": ["status", "city", "state"], "customer.interaction.created": ["customerId", "type", "direction"], "customer.document.uploaded": ["customerId", "category", "filename"],
  "contract.created": ["customerId", "status", "usageModel"], "contract.status.updated": ["status"], "contract.document.uploaded": ["contractId", "category", "filename"],
  "ownership.entitlement.created": ["contractId", "unitId", "priorityLevel"], "unit.maintenance.blocked": ["unitId", "startsAt", "endsAt"],
  "opportunity.created": ["customerId", "stage", "campaignId"], "opportunity.updated": ["stage", "campaignId"], "proposal.created": ["opportunityId", "amount"], "sales.playbook.created": ["stage", "title"],
  "capture.created": ["customerId", "campaignId", "qualificationStatus"], "capture.status.updated": ["presentationStatus", "qualificationStatus"], "capture.checked_in": ["salesRoom"], "capture.room.assigned": ["salesRoom", "salesTable", "linerId", "closerId", "roomManagerId"], "capture.presentation.started": ["salesRoom", "salesTable"], "capture.presentation.ended": ["salesRoom", "salesTable", "durationMinutes"], "capture.no_tour": ["salesRoom", "reason"],
  "installment.renegotiation.proposed": ["installmentId", "proposalAmount"], "installment.paid": ["installmentId", "paidAmount"], "revenue_quality_ledger.synced": ["factCount", "policyVersion"], "financial.entry.created": ["type", "amount", "campaignId"], "financial.entry.reconciled": ["reference", "reconciledAt"], "financial.transfer.created": ["amount", "recipient"], "ai.assistance.requested": ["role", "evidenceCount", "model"],
};

function safeObject(value: string | null) {
  if (!value) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

export function toIntegrationEvent(input: { id: number; eventName: DomainEventName; aggregateType: string; aggregateId: string; actorUserId: number | null; payload: string | null; occurredAt: Date }) {
  const source = safeObject(input.payload);
  const payload = Object.fromEntries(allowedPayloadFields[input.eventName].flatMap(key => key in source ? [[key, source[key]]] : []));
  return { contractVersion: integrationContractVersion, eventId: input.id, eventName: input.eventName, aggregate: { type: input.aggregateType, id: input.aggregateId }, actorUserId: input.actorUserId, occurredAt: input.occurredAt.toISOString(), payload };
}
