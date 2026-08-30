# TGR CRM Audit, Hardening and Delivery Implementation Plan

> **Execution note:** Follow this plan on `audit-delivery-2026-08-29`. Do not merge to `main`, deploy to production, bind real secrets, charge real customers or migrate a shared database without a separate final authorization.

**Goal:** Produce a tested remote release candidate for a controlled TGR CRM pilot, with high-risk integrity defects corrected, an isolated E2E laboratory, reproducible CI evidence and an explicit list of external homologation blockers.

**Architecture:** Preserve the React/Vite + Express/tRPC + Drizzle/MySQL modular monolith. Implement corrections inside existing domain boundaries, keep authorization server-side, preserve audit/event/ledger semantics and use adapters for storage, payment and AI. Every behavior change follows test-first red/green/refactor.

**Tech stack:** TypeScript, React 19, Vite, Express 5, tRPC 11, Drizzle ORM, MySQL/TiDB, Vitest, Playwright, GitHub Actions.

---

## Task 1 — Establish remote truth and CI baseline

**Files:**
- Create: `docs/superpowers/specs/2026-08-29-tgr-crm-audit-delivery-design.md`
- Create: `docs/superpowers/plans/2026-08-29-tgr-crm-audit-delivery.md`
- Create after CI: `docs/audit/2026-08-29-remote-baseline.md`
- Read: `.github/workflows/ci.yml`
- Read: `package.json`

**Steps:**
1. Record remote base `97eb948bc5311c065e68912e343d8b77dc524c5a` and the unavailable local receipt `f3a1011`.
2. Create `audit-delivery-2026-08-29` from the remote wave branch.
3. Open a draft pull request with base `wave1-security-performance-2026-08-25`, not `main`, so the initial diff contains only this delivery work.
4. Trigger the existing pull-request CI without changing production code.
5. Inspect complete quality-job logs before proposing a fix.
6. Write `docs/audit/2026-08-29-remote-baseline.md` with exact SHA, workflow/run/job IDs, command outcomes, warnings and blockers.
7. If the baseline is red, stop all feature work and debug the root cause before proceeding.

**Acceptance:** A reproducible remote baseline exists, and no code correction begins before its result is known.

---

## Task 2 — Make E2E isolation fail closed

**Files:**
- Create: `shared/e2eIsolation.ts`
- Create first: `shared/e2eIsolation.test.ts`
- Modify: `scripts/check-e2e-isolation.mjs`
- Modify: `scripts/seed-e2e-isolated.mjs`
- Modify: `scripts/cleanup-e2e-isolated.mjs`
- Modify if needed: `package.json`

**Behavior to test first:**
1. Reject missing `E2E_DATABASE_URL`.
2. Reject `E2E_DATABASE_URL === DATABASE_URL` after canonical URL normalization.
3. Reject databases whose name does not end in `_e2e`, `_test` or `_staging`.
4. Reject missing `E2E_CONFIRM_ISOLATED=I_CONFIRM_ISOLATED_E2E` for check, seed and cleanup.
5. Reject malformed and non-MySQL URLs.
6. Return only non-secret metadata for logs.

**Steps:**
1. Write failing tests for all six behaviors.
2. Run the focused test and verify each failure is caused by the missing shared guard.
3. Implement the smallest pure `assertIsolatedE2EEnvironment()` helper.
4. Re-run focused tests until green.
5. Import the guard in all three operational scripts through a Node-compatible compiled/runtime path.
6. Add a script-level integration test that proves seed and cleanup abort before opening a database connection when confirmation is missing.
7. Run full typecheck and tests.

**Acceptance:** No seed or cleanup command can connect to a database unless the same strict isolation proof has succeeded.

---

## Task 3 — Replace destructive cleanup with targeted fixture ownership

**Files:**
- Create first: `shared/e2eFixtureIdentity.test.ts`
- Create: `shared/e2eFixtureIdentity.ts`
- Modify: `scripts/seed-e2e-isolated.mjs`
- Modify: `scripts/cleanup-e2e-isolated.mjs`
- Modify: `e2e/global-setup.ts`
- Modify: `e2e/strict-isolated.spec.ts`
- Create: `docs/audit/E2E_FIXTURE_CONTRACT.md`

**Behavior to test first:**
1. Every fixture uses prefix `E2E-TGR-` and a deterministic run ID.
2. Re-running seed for the same run ID is idempotent.
3. Cleanup selects only rows owned by that run ID.
4. Cleanup never executes unqualified `DELETE FROM <table>` statements.
5. Cleanup reports remaining owned rows and fails if count is not zero.
6. Browser owner identity uses TGR naming, not TSE residue.

**Steps:**
1. Write failing pure tests for fixture names, keys and cleanup selectors.
2. Verify red.
3. Implement deterministic fixture identity helpers.
4. Change seed to upsert or first remove only the same run ID.
5. Change cleanup to resolve owned IDs and delete dependent records in foreign-key order.
6. Remove global table deletion and global `FOREIGN_KEY_CHECKS=0` behavior.
7. Add zero-residue verification.
8. Update global setup and E2E assertions to the TGR fixture names.
9. Run focused and full suites.

**Acceptance:** E2E cleanup cannot erase unrelated records even if pointed at an isolated database containing another test run.

---

## Task 4 — Make authenticated E2E reproducible in GitHub Actions

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/config-doctor.mjs`
- Modify: `playwright.config.ts`
- Modify: `e2e/global-setup.ts`
- Modify: `package.json`
- Create if needed: `scripts/e2e-ci-prepare.mjs`
- Create if needed: `scripts/e2e-ci-receipt.mjs`

**Steps:**
1. Inspect the quality baseline and current E2E requirements.
2. Add a MySQL service only to the E2E job, using a database named `tgr_crm_e2e`.
3. Use CI-only non-production secrets and local callback values; never print secret values.
4. Run isolation guard before migrations.
5. Apply reviewed migrations to the disposable service.
6. Seed one deterministic run.
7. Start the server and execute strict Playwright paths.
8. Execute cleanup in an `always()` step.
9. Verify zero owned records remain.
10. Upload Playwright report, traces, screenshots and a small text receipt.
11. Keep the job conditional until the first complete green run; then remove unnecessary external-secret dependency if the self-contained service proves sufficient.

**Acceptance:** A pull request can prove authenticated browser journeys using disposable infrastructure, or the job produces a precise `BLOCKED` receipt naming the irreducible external dependency.

---

## Task 5 — Audit and correct critical money/contract invariants

**Files to inspect:**
- `server/routers/sales.ts`
- `server/routers/contracts.ts`
- `server/routers/commissions.ts`
- `server/routers/finance.ts`
- `server/paymentGateway.ts`
- `server/paymentGatewayWebhook.ts`
- `server/commissionAutomation.ts`
- `server/commissionLifecycle.ts`
- `server/revenueQualitySync.ts`
- `shared/contractLifecycle.ts`
- `shared/opportunityLifecycle.ts`
- Existing `*.integrity.test.ts` and lifecycle tests

**Audit questions:**
1. Can proposal acceptance be mistaken for validated sale or cash?
2. Can the same gateway event create duplicate payment or commission effects?
3. Can an installment be paid, cancelled or renegotiated from an invalid prior state?
4. Can cancellation execute twice or erase paid history?
5. Can commission be released without a valid source installment/payment under the configured policy?
6. Can a user exceed discount authority without an approved request?
7. Are transactional writes committed before success audit/event emission?

**Steps per confirmed defect:**
1. Reproduce from code and existing tests.
2. Document the root cause in the commit message or audit note.
3. Write the smallest failing regression test.
4. Verify red for the expected reason.
5. Implement one root-cause fix.
6. Verify focused tests, then full tests and build.
7. Commit the defect independently.

**Acceptance:** Every confirmed financial/contract defect has a regression test and a single-purpose fix; unconfirmed hypotheses are not changed.

---

## Task 6 — Audit and correct inventory/reservation/import invariants

**Files to inspect:**
- `server/routers/operations.ts`
- `server/routers/ownership.ts`
- `server/routers/imports.ts`
- `shared/reservationLifecycle.ts`
- Existing reservation, ownership, maintenance, waitlist, guest and import integrity tests

**Audit questions:**
1. Can overlapping reservations pass under concurrent requests?
2. Can maintenance be added over active occupancy?
3. Can unit capacity be reduced below active guest count?
4. Can entitlement from one resort authorize inventory in another?
5. Can waitlist conversion exceed capacity or bypass availability?
6. Can import undo remove records that gained downstream dependencies?
7. Can imported seller/customer/contract references cross invalid roles or ownership scopes?

**Steps:** Use the same root-cause and TDD loop as Task 5, one defect per commit.

**Acceptance:** Concurrency-sensitive and dependency-sensitive operations fail closed with tested server-side checks.

---

## Task 7 — Replace raw critical-policy editing with validated administration

**Files:**
- Create first: `shared/projectPolicyForm.test.ts`
- Create: `shared/projectPolicyForm.ts`
- Modify: `shared/projectPolicySchemas.ts`
- Modify: `server/projectPolicy.ts`
- Modify: `server/routers/projectSettings.ts`
- Modify: `client/src/pages/ProjectSettings.tsx`
- Modify/add project-settings tests

**Behavior to test first:**
1. Valid policy forms serialize to the existing versioned policy contract.
2. Invalid percentages, dates, roles, document lists and unknown fields are rejected with field-level errors.
3. Empty/unapproved financial rules remain explicitly `PENDENTE`; no historical fallback is invented.
4. Existing valid stored policies round-trip without semantic loss.

**Steps:**
1. Read all existing schemas and persistence contracts.
2. Write failing round-trip and validation tests.
3. Implement a typed form model and adapters without changing ledger semantics.
4. Replace free-form JSON textareas for the supported policy set with structured controls.
5. Retain an admin-only read-only JSON preview for auditability.
6. Add loading/error/empty/success states and mutation feedback.
7. Run focused tests, full suite, build and E2E navigation.

**Acceptance:** An authorized business administrator can configure supported project rules without manually editing JSON, and unsupported/unapproved rules cannot silently activate.

---

## Task 8 — Accessibility, operational states and interface residue

**Files:**
- Modify first tests: `e2e/accessibility-navigation.authenticated.spec.ts`
- Inspect/modify: `client/src/components/DashboardLayout.tsx`
- Inspect/modify pages touched by failed accessibility tests
- Search runtime source for user-visible `TSE`, internal jokes and misleading readiness claims

**Behavior to test first:**
1. Every primary route has one main landmark and reachable page heading.
2. Sidebar/menu can be traversed by keyboard and focus remains visible.
3. Dialogs trap and restore focus.
4. Form controls have accessible labels and errors.
5. Mobile navigation can open, navigate and close without pointer-only interaction.
6. No runtime user-facing product identity says TSE.

**Steps:**
1. Expand the existing authenticated accessibility spec.
2. Run and collect failures before changing components.
3. Fix one component pattern at a time.
4. Re-run the focused route, then the complete E2E set.
5. Record any checks that still require physical device, screen reader or 200% browser validation as `NOT_TESTED`.

**Acceptance:** Automated keyboard/landmark/form checks pass, and residual manual accessibility checks are not falsely marked complete.

---

## Task 9 — Release evidence, review and pilot handoff

**Files:**
- Create: `docs/audit/TGR_FINAL_PRODUCT_REPORT.md`
- Create: `docs/audit/TGR_E2E_MATRIX.md`
- Create: `docs/audit/TGR_SECURITY_REPORT.md`
- Create: `docs/audit/TGR_KNOWN_ISSUES.md`
- Create: `docs/audit/TGR_PILOT_RUNBOOK.md`
- Update: `DEMO_RUNBOOK.md`
- Update: pull request description

**Steps:**
1. Run fresh quality and E2E workflows on the final branch head.
2. Record exact SHA, run IDs and artifacts.
3. Classify every release criterion as `PASS`, `PARTIAL`, `BLOCKED` or `NOT_TESTED`.
4. Document external blockers: real Asaas credentials/homologation, production e-sign, production backup/restore, legal/LGPD sign-off and missing local `f3a1011` reconciliation.
5. Write pilot rollout and rollback procedures.
6. Request code review on the draft PR.
7. Address review findings with test-first commits.
8. Stop before merge and production deployment.

**Acceptance:** The branch and draft PR are independently auditable, reproducible and safe to present for a final merge/deploy decision.

---

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm config:doctor
pnpm check
pnpm test -- --reporter=dot --pool=forks --poolOptions.forks.singleFork=true
pnpm build
node scripts/check-bundle-budget.mjs
pnpm test:e2e:isolation
pnpm test:browser
```

For strict E2E, the disposable environment must also set:

```bash
E2E_STRICT=1
E2E_CONFIRM_ISOLATED=I_CONFIRM_ISOLATED_E2E
E2E_DATABASE_URL=mysql://.../tgr_crm_e2e
```

## Stop conditions

Stop and classify a real blocker instead of guessing when:

- the missing `f3a1011` history is required to avoid overwriting a conflicting UI change;
- a real provider credential is necessary;
- a business policy cannot be safely represented as configuration;
- a migration needs shared/production data;
- three root-cause fix attempts fail for the same issue;
- a merge or production deployment is the next action.
