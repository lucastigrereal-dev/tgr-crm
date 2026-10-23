export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  salesCommandIntegrationKey: process.env.SALES_COMMAND_INTEGRATION_KEY ?? "",
  // Endpoint de leitura do NQ para o Sales Command: DESLIGADO por padrão; só liga depois do aceite do Lucas.
  nqReadEndpointEnabled: process.env.NQ_READ_ENDPOINT_ENABLED === "true",
  encounterTimesReceiverEnabled: process.env.ENCOUNTER_TIMES_RECEIVER_ENABLED === "true",
  // C2/C3: elegibilidade de não-comprador para o Recovery. DESLIGADA por padrão (a fatia 1 só tem a função pura; a flag vale nas próximas fatias).
  // C2/C3: chave do Recovery para o receptor de opt-out (par endpoint+chave obrigatório; sem chave a rota responde 404).
  recoveryIntegrationKey: process.env.RECOVERY_INTEGRATION_KEY ?? "",
  // Item 10 (admin): catálogo editável/versionado dos indicadores oficiais. DESLIGADO por padrão (tabela é PROPOSTA 0081).
  officialIndicatorCatalogEnabled: process.env.OFFICIAL_INDICATOR_CATALOG_ENABLED === "true",
  // Item 5 (admin): mapa de papéis da comissão V2 configurável. DESLIGADO por padrão; só é lido com o V2 liberado (tabelas são PROPOSTA 0083).
  commissionRoleMapEnabled: process.env.COMMISSION_ROLE_MAP_ENABLED === "true",
  // Item 6 (admin): interruptor MESTRE das sobrescritas de flags pela tela. DESLIGADO por padrão e fora da allow-list (não se liga pela tela). Tabela é PROPOSTA 0084.
  featureFlagOverridesEnabled: process.env.FEATURE_FLAG_OVERRIDES_ENABLED === "true",
  // Item 4 (admin): permissão por papel editável. DESLIGADO por padrão e fora da tela de flags (segurança). Tabela é PROPOSTA 0085.
  permissionOverridesEnabled: process.env.PERMISSION_OVERRIDES_ENABLED === "true",
  // C2/C3: ligada, só grava eventos INTERNOS (non_buyer.*) e o estado local de elegibilidade; nada é entregue ao Recovery (a fatia 5, entrega externa, não existe). Tabelas são PROPOSTA 0080.
  recoveryEligibilityEnabled: process.env.RECOVERY_ELIGIBILITY_ENABLED === "true",
  // C1: receptor encounter.attendance_recorded.v1 (registro canônico do casal). DESLIGADO por padrão.
  attendanceReceiverEnabled: process.env.ATTENDANCE_RECEIVER_ENABLED === "true",
  // F2.10: exclusão LGPD propagada do GuestPass (feed por pull + recibo). DESLIGADA por padrão. Tabelas são PROPOSTA 0088. Anonimiza só dado do CRM, mantendo nome/CPF/data do brinde.
  privacyErasurePropagationEnabled: process.env.PRIVACY_ERASURE_PROPAGATION_ENABLED === "true",
  privacyErasureEndpoint: process.env.GUESTPASS_PRIVACY_BRIDGE_ENDPOINT ?? "",
  privacyErasureKey: process.env.GUESTPASS_PRIVACY_BRIDGE_KEY ?? "",
  privacyErasureHmacSecret: process.env.GUESTPASS_PRIVACY_BRIDGE_HMAC_SECRET ?? "",
  // F3.1 (MODO SOMBRA): fila de resgate do pós-vendas e registro do que o distrato automático FARIA. DESLIGADA por padrão. Tabelas são PROPOSTA 0086. Nunca cancela contrato.
  rescueQueueEnabled: process.env.RESCUE_QUEUE_ENABLED === "true",
  // F3.1: RESERVADA para o distrato automático real (F4). Nesta fatia NENHUM código a lê para agir: o caminho automático não existe. Nasce false.
  autoCancellationEnabled: process.env.AUTO_CANCELLATION_ENABLED === "true",
  // CRM-A07: varredura de blob órfão no armazenamento local. DESLIGADA por padrão; ligada sem DELETE só relata (ensaio).
  gatewayRecoveryEnabled: process.env.GATEWAY_RECOVERY_ENABLED !== "false",
  gatewayRecoveryIntervalMinutes: Math.max(1, Math.min(24 * 60, Math.trunc(Number(process.env.GATEWAY_RECOVERY_INTERVAL_MINUTES ?? 5)) || 5)),
  gatewayRecoveryMinAgeMinutes: Math.max(1, Math.min(24 * 60, Math.trunc(Number(process.env.GATEWAY_RECOVERY_MIN_AGE_MINUTES ?? 10)) || 10)),
  orphanBlobSweepEnabled: process.env.ORPHAN_BLOB_SWEEP_ENABLED === "true",
  orphanBlobSweepDelete: process.env.ORPHAN_BLOB_SWEEP_DELETE === "true",
  orphanBlobMinAgeHours: Math.max(1, Math.min(24 * 90, Math.trunc(Number(process.env.ORPHAN_BLOB_MIN_AGE_HOURS ?? 24)) || 24)),
  orphanBlobSweepIntervalHours: Math.max(1, Math.min(24 * 30, Math.trunc(Number(process.env.ORPHAN_BLOB_SWEEP_INTERVAL_HOURS ?? 24)) || 24)),
  relationshipEndpoint: process.env.RELATIONSHIP_ENDPOINT ?? "",
  relationshipCrmIntegrationKey: process.env.RELATIONSHIP_CRM_INTEGRATION_KEY ?? "",
  salesCommandEndpoint: process.env.SALES_COMMAND_ENDPOINT ?? "",
  salesCommandCancellationKey: process.env.SALES_COMMAND_CANCELLATION_KEY ?? "",
  host: process.env.HOST ?? "",
  // Quantos proxies confiáveis existem na frente do app (0 = nenhum: req.ip é o IP da conexão). Só >0 atrás de proxy conhecido.
  trustProxyHops: Math.max(0, Math.min(5, Math.trunc(Number(process.env.TRUST_PROXY_HOPS ?? 0)) || 0)),
  financialEndpoint: process.env.FINANCIAL_ENDPOINT ?? "",
  financialCrmIntegrationKey: process.env.FINANCIAL_CRM_INTEGRATION_KEY ?? "",
  financialProjectExternalKey: process.env.FINANCIAL_PROJECT_EXTERNAL_KEY ?? "",
  csrfOriginCheckEnabled: process.env.CSRF_ORIGIN_CHECK_ENABLED === "true",
  csrfAllowedOrigins: (process.env.CSRF_ALLOWED_ORIGINS ?? "").split(",").map(item => item.trim()).filter(Boolean),
  financialProjectMapEnabled: process.env.FINANCIAL_PROJECT_MAP_ENABLED === "true",
  financialProjectName: process.env.FINANCIAL_PROJECT_NAME ?? "",
  financialProjectTimezone: process.env.FINANCIAL_PROJECT_TIMEZONE ?? "America/Recife",
};
