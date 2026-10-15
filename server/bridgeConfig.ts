// P-05 (piloto na sala): quais pontes de saída o CRM liga a partir do ambiente. Tudo vazio = todas desligadas e o CRM sobe
// normalmente (é o piloto: Financial, Relationship e Recovery desligados). Meia configuração (endereço sem chave, ou o
// contrário) é erro de boot: uma ponte "meio ligada" perderia evento em silêncio.
export interface BridgeEnv {
  relationshipEndpoint: string;
  relationshipCrmIntegrationKey: string;
  salesCommandEndpoint: string;
  salesCommandCancellationKey: string;
  financialEndpoint: string;
  financialCrmIntegrationKey: string;
  financialProjectExternalKey: string;
  financialProjectName: string;
  financialProjectTimezone: string;
}

export interface BridgeConfig {
  relationship: { endpoint: string; key: string } | null;
  salesCancellation: { endpoint: string; key: string } | null;
  financial: { endpoint: string; key: string; project: { externalKey: string; name: string; timezone: string } } | null;
}

export function resolveBridgeConfig(env: BridgeEnv): BridgeConfig {
  const relationshipEndpoint = env.relationshipEndpoint.trim();
  const relationshipKey = env.relationshipCrmIntegrationKey.trim();
  if (Boolean(relationshipEndpoint) !== Boolean(relationshipKey)) {
    throw new Error("Relationship bridge configuration incomplete");
  }
  const salesEndpoint = env.salesCommandEndpoint.trim();
  const salesCancellationKey = env.salesCommandCancellationKey.trim();
  if (Boolean(salesEndpoint) !== Boolean(salesCancellationKey)) {
    throw new Error("Sales Command cancellation bridge configuration incomplete");
  }
  const financialEndpoint = env.financialEndpoint.trim();
  const financialKey = env.financialCrmIntegrationKey.trim();
  const project = {
    externalKey: env.financialProjectExternalKey.trim(),
    name: env.financialProjectName.trim(),
    timezone: env.financialProjectTimezone.trim(),
  };
  if (Boolean(financialEndpoint) !== Boolean(financialKey)) {
    throw new Error("Financial bridge configuration incomplete");
  }
  if (financialEndpoint && (!project.externalKey || !project.name || !project.timezone)) {
    throw new Error("Financial project identity incomplete");
  }
  return {
    relationship: relationshipEndpoint ? { endpoint: relationshipEndpoint, key: relationshipKey } : null,
    salesCancellation: salesEndpoint ? { endpoint: salesEndpoint, key: salesCancellationKey } : null,
    financial: financialEndpoint ? { endpoint: financialEndpoint, key: financialKey, project } : null,
  };
}
