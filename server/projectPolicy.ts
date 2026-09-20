import { getCaptureReadiness, type CaptureReadinessInput } from "./captureDomain";
import {
  commissionPolicySchema,
  type CommissionPolicy,
  type CommissionPolicyDraft,
} from "../shared/projectPolicySchemas";

const allowed = [
  "customerName",
  "phone",
  "city",
  "promoterId",
  "captureLocation",
  "averageIncome",
  "travelWeeksPerYear",
  "qualificationStatus",
  "vehicle",
  "homeOwnership",
] as const;

export type ProjectCommissionPolicy = CommissionPolicyDraft;

export function parseCommissionPolicy(
  raw: string | null | undefined,
): ProjectCommissionPolicy {
  try {
    const value = JSON.parse(raw || "{}");
    return typeof value === "object" && value ? value : {};
  } catch {
    return {};
  }
}

/**
 * Automatic commission is only allowed with every field required by the policy.
 * Invalid or partial JSON returns null instead of historical defaults.
 */
export function parseCompleteCommissionPolicy(
  raw: string | null | undefined,
): CommissionPolicy | null {
  const parsed = commissionPolicySchema.safeParse(parseCommissionPolicy(raw));
  return parsed.success ? parsed.data : null;
}

export type ProjectCancellationPolicy = {
  penaltyRate?: number;
  penaltyBase?: "paid" | "contract";
  refundMode?: "full" | "after_penalty" | "none";
};

export function parseCancellationPolicy(
  raw: string | null | undefined,
): ProjectCancellationPolicy {
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object") return {};
    const policy = value as ProjectCancellationPolicy;
    return {
      penaltyRate:
        typeof policy.penaltyRate === "number" &&
        policy.penaltyRate >= 0 &&
        policy.penaltyRate <= 1
          ? policy.penaltyRate
          : undefined,
      penaltyBase:
        policy.penaltyBase === "paid" || policy.penaltyBase === "contract"
          ? policy.penaltyBase
          : undefined,
      refundMode:
        policy.refundMode === "full" ||
        policy.refundMode === "after_penalty" ||
        policy.refundMode === "none"
          ? policy.refundMode
          : undefined,
    };
  } catch {
    return {};
  }
}

export function parseRequiredCaptureFields(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is (typeof allowed)[number] =>
            typeof value === "string" &&
            (allowed as readonly string[]).includes(value),
        )
      : [];
  } catch {
    return [];
  }
}

export function parseRequiredContractDocuments(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length >= 2 && value.length <= 80),
      ),
    );
  } catch {
    return [];
  }
}

export function getProjectCaptureReadiness(
  input: CaptureReadinessInput & {
    vehicle?: string | null;
    homeOwnership?: string | null;
  },
  requiredRaw?: string | null,
) {
  const base = getCaptureReadiness(input);
  const extra = parseRequiredCaptureFields(requiredRaw)
    .filter(
      (field) =>
        ![
          "customerName",
          "phone",
          "city",
          "promoterId",
          "captureLocation",
          "averageIncome",
          "travelWeeksPerYear",
          "qualificationStatus",
        ].includes(field),
    )
    .filter((field) => !input[field as "vehicle" | "homeOwnership"]);
  const missing = Array.from(
    new Set([
      ...base.missing,
      ...extra.map((field) => (field === "vehicle" ? "Veículo" : "Moradia")),
    ]),
  );
  return {
    completed: base.total + extra.length - missing.length,
    total: base.total + extra.length,
    percent: Math.round(
      ((base.total + extra.length - missing.length) /
        (base.total + extra.length)) *
        100,
    ),
    missing,
  };
}
