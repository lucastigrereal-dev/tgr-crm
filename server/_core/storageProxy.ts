import type { Express } from "express";
import { authorizeStorageRead } from "../storageAccess";
import { recordAudit } from "../db";
import { logger } from "../logger";
import { createContext } from "./context";
import { ENV } from "./env";
import { fetchWithTimeout } from "../integrationReliability";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*splat", async (req, res) => {
    const splat = req.params.splat;
    const rawKey = Array.isArray(splat) ? splat.join("/") : splat;
    if (!rawKey) {
      res.status(400).send("Missing storage key");
      return;
    }

    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      res.status(403).send("Storage access denied");
      return;
    }

    const context = await createContext({ req, res } as never);
    const authorization = await authorizeStorageRead(context.user, key);
    if (!authorization.allowed) {
      res.status(authorization.status).send(
        authorization.reason === "authorization_unavailable"
          ? "Storage authorization unavailable"
          : "Storage access denied",
      );
      return;
    }

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetchWithTimeout(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        logger.error("Storage provider returned an error", { status: forgeResp.status });
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      try {
        await recordAudit(
          context.user!.id,
          `${authorization.scope}_document`,
          authorization.resourceId,
          "read",
          "Documento acessado por usuário autenticado.",
        );
      } catch (error) {
        logger.warn("Storage read audit failed after presign", { error: error instanceof Error ? error.message : "unknown_error" });
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      logger.error("Storage proxy failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(502).send("Storage proxy error");
    }
  });
}
