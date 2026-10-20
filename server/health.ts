import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { getDb } from "./db";
import { localAuthStatus } from "./localAuth";
import { getLocalStorageRoot } from "./localStorage";

/** CRM-A28: SHA do commit gravado na imagem (ARG GIT_SHA do Dockerfile). Só aceita hex de 7 a 64 caracteres; qualquer outra coisa vira "unknown". */
export function buildGitSha(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.GIT_SHA ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(raw) ? raw : "unknown";
}

function requestId(req: Request) {
  return req.requestId ?? null;
}

export function registerHealthRoutes(app: Express) {
  app.get("/api/health/live", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "tgr-crm", gitSha: buildGitSha(), requestId: requestId(req), now: new Date().toISOString() });
  });

  app.get("/api/health/ready", async (req: Request, res: Response) => {
    const checks: Record<string, "ok" | "missing" | "failed"> = {
      database: "missing",
      session: process.env.JWT_SECRET ? "ok" : "missing",
    };

    try {
      const db = await getDb();
      if (db) {
        await db.execute(sql`select 1`);
        checks.database = "ok";
      }
    } catch {
      checks.database = "failed";
    }

    if (process.env.LOCAL_AUTH_ENABLED === "1") {
      checks.localAuth = localAuthStatus().enabled ? "ok" : "failed";
    }

    const storageRoot = getLocalStorageRoot();
    if (storageRoot) {
      try {
        await mkdir(storageRoot, { recursive: true });
        await access(storageRoot, fsConstants.W_OK);
        checks.storage = "ok";
      } catch {
        checks.storage = "failed";
      }
    }

    const ready = Object.values(checks).every(value => value === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", service: "tgr-crm", gitSha: buildGitSha(), requestId: requestId(req), checks, now: new Date().toISOString() });
  });
}
