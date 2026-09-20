import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { getDb } from "./db";
import { localAuthStatus } from "./localAuth";
import { getLocalStorageRoot } from "./localStorage";

function requestId(req: Request) {
  return req.requestId ?? null;
}

export function registerHealthRoutes(app: Express) {
  app.get("/api/health/live", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "tgr-crm", requestId: requestId(req), now: new Date().toISOString() });
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
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", service: "tgr-crm", requestId: requestId(req), checks, now: new Date().toISOString() });
  });
}
