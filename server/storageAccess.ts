import { and, eq } from "drizzle-orm";
import type { User } from "../drizzle/schema";
import {
  contractDocuments,
  customerDocuments,
} from "../drizzle/schema";
import { getDb } from "./db";

const internalRoles = new Set(["admin", "seller", "finance", "service"]);

type StorageScope = "customer" | "contract";

type ParsedStorageKey = {
  scope: StorageScope;
  resourceId: number;
};

export type StorageAccessResult =
  | {
      allowed: true;
      scope: StorageScope;
      resourceId: number;
    }
  | {
      allowed: false;
      status: 401 | 403 | 503;
      reason: "unauthenticated" | "forbidden" | "authorization_unavailable";
    };

function parseStorageKey(key: string): ParsedStorageKey | null {
  const match = /^(customers|contracts)\/(\d+)\/[^/]+$/.exec(key);
  if (!match) return null;
  const resourceId = Number(match[2]);
  if (!Number.isSafeInteger(resourceId) || resourceId <= 0) return null;
  return {
    scope: match[1] === "customers" ? "customer" : "contract",
    resourceId,
  };
}

/**
 * A signed URL is issued only after authentication and document ownership
 * have both been proven against the CRM database.
 */
export async function authorizeStorageRead(
  user: Pick<User, "id" | "role"> | null,
  key: string,
): Promise<StorageAccessResult> {
  if (!user) {
    return { allowed: false, status: 401, reason: "unauthenticated" };
  }
  if (!internalRoles.has(user.role)) {
    return { allowed: false, status: 403, reason: "forbidden" };
  }

  const parsed = parseStorageKey(key);
  if (!parsed) {
    return { allowed: false, status: 403, reason: "forbidden" };
  }

  const db = await getDb();
  if (!db) {
    return {
      allowed: false,
      status: 503,
      reason: "authorization_unavailable",
    };
  }

  const document =
    parsed.scope === "customer"
      ? await db
          .select({ id: customerDocuments.id })
          .from(customerDocuments)
          .where(
            and(
              eq(customerDocuments.customerId, parsed.resourceId),
              eq(customerDocuments.storageKey, key),
            ),
          )
          .limit(1)
      : await db
          .select({ id: contractDocuments.id })
          .from(contractDocuments)
          .where(
            and(
              eq(contractDocuments.contractId, parsed.resourceId),
              eq(contractDocuments.storageKey, key),
            ),
          )
          .limit(1);

  // Deliberately return 403 for unknown keys to avoid exposing existence.
  if (!document.length) {
    return { allowed: false, status: 403, reason: "forbidden" };
  }

  return {
    allowed: true,
    scope: parsed.scope,
    resourceId: parsed.resourceId,
  };
}
