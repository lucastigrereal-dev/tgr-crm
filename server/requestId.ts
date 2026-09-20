import crypto from "node:crypto";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

export const attachRequestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id")?.trim();
  const requestId = incoming && requestIdPattern.test(incoming) ? incoming : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};
