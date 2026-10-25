import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { applySecurityHeaders, createOriginGuard } from "../securityHeaders";
import { attachRequestId } from "../requestId";
import { subscribeSalesRoom } from "../realtime";
import { processAsaasWebhook } from "../paymentGatewayWebhook";
import { registerHealthRoutes } from "../health";
import { logger } from "../logger";
import { registerSalesCommandBridge } from "../salesCommandBridge";
import { registerRelationshipCancellationGate, registerRelationshipCancellationReceiver } from "../relationshipCancellationReceiver";
import { registerRecoveryOptOutGate, registerRecoveryOptOutReceiver } from "../recoveryOptOutReceiver";
import { registerAttendanceGate, registerAttendanceReceiver } from "../attendanceReceiver";
import { registerEncounterTimesReceiver } from "../encounterTimesReceiver";
import { registerUnknownCoupleWatch } from "../unlinkedCouples";
import { registerNqReadEndpoint } from "../nqReadEndpoint";
import { ENV } from "./env";
import { startRelationshipBridgePump, startSalesCancellationBridgePump, type RelationshipBridgePump, type SalesCancellationBridgePump } from "../relationshipBridge";
import { processClicksignWebhook } from "../eSignatureService";
import { resolveBridgeConfig } from "../bridgeConfig";
import { startFinancialBridgePump, type FinancialBridgePump } from "../financialBridge";
import { startPointsExpiryJob, type PointsExpiryJob } from "../pointsExpiryJob";
import { startHoldExpiryJob, type HoldExpiryJob } from "../holdExpiryJob";
import { startNonBuyerDeliveryJob, type NonBuyerDeliveryJob } from "../nonBuyerDeliveryJob";
import { isAllowedDeliveryEndpoint } from "../nonBuyerDelivery";
import { startPrivacyErasureJob, type PrivacyErasureJob } from "../privacyErasureJob";
import { isAllowedFeedEndpoint } from "../privacyErasureFeed";
import { startRescueQueueJob, type RescueQueueJob } from "../rescueQueueJob";
import { startNonBuyerReconciliationJob, type NonBuyerReconciliationJob } from "../nonBuyerReconciliationJob";
import { startGatewayRecoveryJob, type GatewayRecoveryJob } from "../gatewayIssueRecovery";
import { getDb } from "../db";
import { applyPersistedFlagOverrides } from "../featureFlags";
import { applyPersistedPermissionOverrides } from "../permissionOverrides";
import { getAsaasConfig } from "../paymentGateway";
import { startOrphanBlobSweepJob, type OrphanBlobSweepJob } from "../orphanBlobSweep";

const SALES_ROOM_STREAM_ROLES = new Set(["admin", "seller", "service"]);

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const bridges = resolveBridgeConfig(ENV);
  let relationshipPump: RelationshipBridgePump | undefined;
  let salesCancellationPump: SalesCancellationBridgePump | undefined;
  let financialPump: FinancialBridgePump | undefined;
  let pointsExpiryJob: PointsExpiryJob | undefined;
  let holdExpiryJob: HoldExpiryJob | undefined;
  let nonBuyerReconciliationJob: NonBuyerReconciliationJob | undefined;
  let nonBuyerDeliveryJob: NonBuyerDeliveryJob | undefined;
  let privacyErasureJob: PrivacyErasureJob | undefined;
  let rescueQueueJob: RescueQueueJob | undefined;
  let orphanBlobSweepJob: OrphanBlobSweepJob | undefined;
  let gatewayRecoveryJob: GatewayRecoveryJob | undefined;
  // Item 6: sobrescritas persistidas das flags da allow-list valem ANTES de registrar rotas e jobs (mestre FEATURE_FLAG_OVERRIDES_ENABLED desligado = nada acontece).
  await applyPersistedFlagOverrides(await getDb());
  await applyPersistedPermissionOverrides(await getDb()); // item 4: flag PERMISSION_OVERRIDES_ENABLED desligada = nada acontece
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  // KAN-30: sem proxy confiável (padrão) req.ip é o IP da conexão e X-Forwarded-For forjado é ignorado; atrás de N proxies conhecidos, TRUST_PROXY_HOPS=N.
  if (ENV.trustProxyHops > 0) app.set("trust proxy", ENV.trustProxyHops);
  app.use(attachRequestId);
  app.use(applySecurityHeaders);
  app.use(createOriginGuard({ enabled: ENV.csrfOriginCheckEnabled, allowedOrigins: ENV.csrfAllowedOrigins }));
  app.post("/api/webhooks/clicksign", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const signature = req.get("x-clicksign-signature") || req.get("content-hmac") || undefined;
    const result = await processClicksignWebhook(signature, rawBody);
    res.status(result.status).json(result);
  });
  // C1: portão de auth do receptor de atendimento ANTES do parser global (401 sem ler o corpo; JSON ruim = 400 só com chave).
  registerAttendanceGate(app, ENV.salesCommandIntegrationKey, ENV.attendanceReceiverEnabled);
  registerRecoveryOptOutGate(app, ENV.recoveryIntegrationKey, ENV.recoveryEligibilityEnabled);
  registerRelationshipCancellationGate(app, ENV.relationshipInboundKey, ENV.relationshipCancellationInboxEnabled);
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ limit: "12mb", extended: true, parameterLimit: 100 }));
  registerHealthRoutes(app);
  registerSalesCommandBridge(app, ENV.salesCommandIntegrationKey);
  registerUnknownCoupleWatch(app, ENV.encounterTimesReceiverEnabled); // F1.4: 422 por casal sem ficha vira alerta no painel (antes do receptor; não o altera)
  registerEncounterTimesReceiver(app, ENV.salesCommandIntegrationKey, ENV.encounterTimesReceiverEnabled);
  registerAttendanceReceiver(app, ENV.salesCommandIntegrationKey, ENV.attendanceReceiverEnabled);
  registerRecoveryOptOutReceiver(app, ENV.recoveryIntegrationKey, ENV.recoveryEligibilityEnabled);
  registerRelationshipCancellationReceiver(app, ENV.relationshipInboundKey, ENV.relationshipCancellationInboxEnabled);
  registerNqReadEndpoint(app, ENV.salesCommandIntegrationKey, ENV.nqReadEndpointEnabled);
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  app.post("/api/webhooks/asaas", async (req, res) => {
    const result = await processAsaasWebhook(req.get("asaas-access-token") || undefined, req.body);
    res.status(result.status).json(result);
  });

  app.get("/api/realtime/sales-room", async (req, res) => {
    const context = await createContext({ req, res } as never);
    if (!context.user) {
      res.status(401).json({ error: "Não autenticado." });
      return;
    }
    // KAN-30: mesmo recorte de perfil da fila da recepção (receptionProcedure); financeiro/outros perfis não escutam a sala.
    if (!SALES_ROOM_STREAM_ROLES.has(context.user.role)) {
      res.status(403).json({ error: "Acesso à sala de vendas não autorizado." });
      return;
    }

    const requestedRoom = typeof req.query.salesRoom === "string" ? req.query.salesRoom.trim() : "";
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: Parameters<typeof subscribeSalesRoom>[0] extends (value: infer T) => void ? T : never) => {
      if (requestedRoom && event.salesRoom && event.salesRoom !== requestedRoom) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribeSalesRoom(send);
    res.write(`event: ready\ndata: ${JSON.stringify({ topic: "sales-room", requestedRoom: requestedRoom || null, occurredAt: new Date().toISOString() })}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled request error", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    if (res.headersSent) return;
    res.status(500).json({ error: "Erro interno do servidor.", requestId: req.requestId ?? null });
  });

  const preferredPort = parseInt(process.env.PORT || "3000");
  const strictE2EPort = process.env.E2E_STRICT === "1";
  if (strictE2EPort && !(await isPortAvailable(preferredPort))) {
    throw new Error(`Preferred port ${preferredPort} unavailable in strict E2E mode`);
  }
  const port = strictE2EPort ? preferredPort : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    logger.warn("Preferred port unavailable; using fallback port", { preferredPort, port });
  }

  const shutdown = (signal: string) => {
    relationshipPump?.stop();
    salesCancellationPump?.stop();
    financialPump?.stop();
    pointsExpiryJob?.stop();
    holdExpiryJob?.stop();
    nonBuyerReconciliationJob?.stop();
    nonBuyerDeliveryJob?.stop();
    privacyErasureJob?.stop();
    rescueQueueJob?.stop();
    orphanBlobSweepJob?.stop();
    gatewayRecoveryJob?.stop();
    logger.info("Graceful shutdown requested", { signal });
    server.close(error => {
      if (error) {
        logger.error("Graceful shutdown failed", { signal, error: error.message });
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // HOST opcional (ex.: 127.0.0.1), como nos apps da Suite; vazio mantém todas as interfaces.
  server.listen(port, ENV.host.trim() || undefined, () => {
    if (bridges.relationship) {
      relationshipPump = startRelationshipBridgePump(bridges.relationship.endpoint, bridges.relationship.key, {
        onError: error => logger.error("Relationship bridge delivery failed", { error: error instanceof Error ? error.message : "unknown_error" }),
      });
    }
    if (bridges.salesCancellation) {
      salesCancellationPump = startSalesCancellationBridgePump(bridges.salesCancellation.endpoint, bridges.salesCancellation.key, {
        onError: error => logger.error("Sales Command cancellation delivery failed", { error: error instanceof Error ? error.message : "unknown_error" }),
      });
    }
    if (bridges.financial) {
      financialPump = startFinancialBridgePump(bridges.financial.endpoint, bridges.financial.key, bridges.financial.project, {
        projectMapEnabled: ENV.financialProjectMapEnabled,
        onError: error => logger.error("Financial bridge delivery failed", { error: error instanceof Error ? error.message : "unknown_error" }),
      });
    }
    pointsExpiryJob = startPointsExpiryJob({
      onError: error => logger.error("Points expiry job failed", { error: error instanceof Error ? error.message : "unknown_error" }),
      onRun: result => { if (result.settled > 0) logger.info("Points expiry job settled", result); },
    });
    holdExpiryJob = startHoldExpiryJob({
      onError: error => logger.error("Hold expiry job failed", { error: error instanceof Error ? error.message : "unknown_error" }),
      onRun: result => { if (result.holds > 0) logger.info("Hold expiry job released", { holds: result.holds, fractions: result.fractions.length }); },
    });
    // C2/C3: DESLIGADA por padrão. Reconciliação durável da elegibilidade de não-comprador (precisa da migration 0080 aplicada); não entrega nada a ninguém.
    if (ENV.recoveryEligibilityEnabled) {
      nonBuyerReconciliationJob = startNonBuyerReconciliationJob({
        onError: error => logger.error("Non-buyer eligibility reconciliation failed", { error: error instanceof Error ? error.message : "unknown_error" }),
        onRun: result => { if (result.changed > 0) logger.info("Non-buyer eligibility reconciled", { ...result }); },
      });
    }
    // F2.1: DESLIGADA por padrão. Entrega non_buyer.* ao Recovery; precisa da migration PROPOSED_0089, da elegibilidade ligada, de endpoint https e de chave. Sem configuração completa não inicia.
    if (ENV.nonBuyerDeliveryEnabled) {
      if (ENV.recoveryEligibilityEnabled && isAllowedDeliveryEndpoint(ENV.nonBuyerDeliveryEndpoint) && ENV.nonBuyerDeliveryKey) {
        nonBuyerDeliveryJob = startNonBuyerDeliveryJob({ endpoint: ENV.nonBuyerDeliveryEndpoint, key: ENV.nonBuyerDeliveryKey }, {
          onError: error => logger.error("Non-buyer delivery failed", { error: error instanceof Error ? error.name : "unknown_error" }),
          onRun: result => { if (result.delivered + result.rejected + result.retried > 0) logger.info("Non-buyer delivery", { ...result }); },
        });
      } else logger.warn("NON_BUYER_DELIVERY_ENABLED is on but RECOVERY_ELIGIBILITY_ENABLED, endpoint or key is missing or invalid; job not started");
    }
    // F2.10: DESLIGADA por padrão. Exclusão LGPD propagada do GuestPass (pull + recibo); precisa da migration PROPOSED_0088 e de endpoint https, chave e segredo. Sem configuração completa não inicia.
    if (ENV.privacyErasurePropagationEnabled) {
      if (isAllowedFeedEndpoint(ENV.privacyErasureEndpoint) && ENV.privacyErasureKey && ENV.privacyErasureHmacSecret) {
        privacyErasureJob = startPrivacyErasureJob({ endpoint: ENV.privacyErasureEndpoint, key: ENV.privacyErasureKey, hmacSecret: ENV.privacyErasureHmacSecret }, {
          onError: error => logger.error("Privacy erasure sync failed", { error: error instanceof Error ? error.name : "unknown_error" }),
          onRun: result => { if (result.received + result.receiptsDelivered + result.receiptsFailed > 0) logger.info("Privacy erasure sync", { ...result }); },
        });
      } else logger.warn("PRIVACY_ERASURE_PROPAGATION_ENABLED is on but endpoint, key or HMAC secret is missing or invalid; job not started");
    }
    // F3.1: DESLIGADA por padrão. MODO SOMBRA do resgate/distrato: só registra casos e eventos internos (precisa da migration PROPOSED_0086); nunca cancela contrato.
    if (ENV.rescueQueueEnabled) {
      rescueQueueJob = startRescueQueueJob({
        onError: error => logger.error("Rescue queue sweep failed", { error: error instanceof Error ? error.message : "unknown_error" }),
        onRun: result => { if (result.opened + result.rescued + result.cancelled + result.due + result.wouldRun + result.manualReview + result.errors > 0) logger.info("Rescue queue sweep", { ...result }); },
      });
    }
    // CRM-A10: só lê o Asaas e reconcilia intenções de emissão pendentes; sem Asaas configurado não faz nada.
    if (ENV.gatewayRecoveryEnabled) {
      gatewayRecoveryJob = startGatewayRecoveryJob({
        getDb, getConfig: () => getAsaasConfig(), intervalMs: ENV.gatewayRecoveryIntervalMinutes * 60_000, minAgeMs: ENV.gatewayRecoveryMinAgeMinutes * 60_000,
        onError: error => logger.error("Gateway recovery failed", { error: error instanceof Error ? error.message : "unknown_error" }),
        onRun: result => { if (result.scanned > 0) logger.warn("Gateway orphan billing recovery", { ...result }); },
      });
    }
    // CRM-A07: desligada por padrão. Ligada sem ORPHAN_BLOB_SWEEP_DELETE só relata os arquivos órfãos (ensaio).
    if (ENV.orphanBlobSweepEnabled) {
      orphanBlobSweepJob = startOrphanBlobSweepJob({
        minAgeHours: ENV.orphanBlobMinAgeHours, deleteOrphans: ENV.orphanBlobSweepDelete, intervalMs: ENV.orphanBlobSweepIntervalHours * 3_600_000,
        onError: error => logger.error("Orphan blob sweep failed", { error: error instanceof Error ? error.message : "unknown_error" }),
        onRun: result => { if (!result.supported) logger.warn("Orphan blob sweep not supported", { reason: result.reason }); else if (result.orphans.length) logger.warn("Orphan blobs found", { count: result.orphans.length, bytes: result.orphanBytes, deleted: result.deleted, failed: result.failed, dryRun: result.dryRun }); },
      });
    }
    logger.info("Server running", { port });
  });
}

startServer().catch(error => logger.error("Server startup failed", { error: error instanceof Error ? error.message : "unknown_error" }));
