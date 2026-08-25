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
import { applySecurityHeaders } from "../securityHeaders";
import { attachRequestId } from "../requestId";
import { subscribeSalesRoom } from "../realtime";
import { processAsaasWebhook } from "../paymentGatewayWebhook";
import { registerHealthRoutes } from "../health";
import { logger } from "../logger";

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
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  app.use(attachRequestId);
  app.use(applySecurityHeaders);
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ limit: "12mb", extended: true, parameterLimit: 100 }));
  registerHealthRoutes(app);
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

    const requestedRoom = typeof req.query.salesRoom === "string" ? req.query.salesRoom.trim() : "";
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: Parameters<typeof subscribeSalesRoom>[0] extends (value: infer T) => void ? T : never) => {
      if (requestedRoom && event.salesRoom && event.salesRoom !== requestedRoom) return;
      res.write(`event: ${event.type}\\ndata: ${JSON.stringify(event)}\\n\\n`);
    };
    const unsubscribe = subscribeSalesRoom(send);
    res.write(`event: ready\\ndata: ${JSON.stringify({ topic: "sales-room", requestedRoom: requestedRoom || null, occurredAt: new Date().toISOString() })}\\n\\n`);
    const heartbeat = setInterval(() => res.write(": ping\\n\\n"), 20_000);
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
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  const shutdown = (signal: string) => {
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

  server.listen(port, () => {
    logger.info("Server running", { port });
  });
}

startServer().catch(console.error);
