# TGR CRM Audit, Hardening and Delivery Design

**Date:** 2026-08-29  
**Product:** TGR CRM only  
**Execution branch:** `audit-delivery-2026-08-29`  
**Remote base:** `wave1-security-performance-2026-08-25` at `97eb948bc5311c065e68912e343d8b77dc524c5a`

## 1. Mission

Audit, correct, harden and prepare the TGR CRM for a controlled operational pilot without rebuilding the product or mixing it with TGR Consulting.

The TGR CRM is the operational system for a multipropriedade company. It owns the real flow from capture and reception through sales, contracts, installments, collection, commissions, revenue quality, ownership rights, reservations and relationship management.

The delivery target is a **release candidate supported by reproducible evidence**, not a marketing declaration. The product can only advance from code-tested to pilot-ready after authenticated end-to-end validation in an isolated environment.

## 2. Canonical product boundary

### In scope

- Customers and household history
- Capture, qualification, scheduling and reception
- Sales room, consultant/liner, closer and operational timestamps
- Opportunities, proposals, discounts, goals and campaigns
- Contracts, installments, documents and cancellation lifecycle
- Payment gateway adapter, webhook integrity and reconciliation
- Commissions, source-of-funds linkage and reversals
- Revenue-quality ledger and management exceptions
- Inventory, entitlements, maintenance, reservations, waitlist and guests
- Tasks, follow-up, dashboards, imports, audit events and permissioned AI
- Security, access control, observability, accessibility and release governance

### Out of scope for this delivery

- TGR Consulting, Project Builder, Boardroom, Goal Seek or financial planning features
- Copying TSE code, binaries, schemas, data, credentials or proprietary artifacts
- Production deployment
- Real customer PII
- Real banking credentials or real charges
- Applying migrations to a production or shared database
- Merging to `main` without an explicit final release authorization
- Rebuilding the modular monolith or changing framework without a proven blocker

## 3. Source-of-truth rule

The remote repository is currently inconsistent with a later local audit receipt:

- Remote `wave1-security-performance-2026-08-25` resolves to `97eb948...`.
- A later local checkout was documented at `f3a1011` (`fix: improve CRM interface clarity`).
- `f3a1011` is not available in the connected GitHub repository.

This delivery will therefore:

1. preserve the remote branch unchanged;
2. work only on `audit-delivery-2026-08-29`;
3. never force-update or overwrite the missing local history;
4. record all new changes as independently reviewable commits;
5. require reconciliation with `f3a1011` before any final merge if that commit is later recovered.

## 4. Architecture to preserve

The existing modular monolith remains authoritative:

```text
React/Vite/TypeScript
        ↓ typed tRPC
Express/tRPC routers
        ↓
Domain services + server-side authorization
        ↓
Drizzle ORM
        ↓
MySQL/TiDB
```

Cross-cutting layers remain adapters or services rather than new parallel systems:

- OAuth/session and capabilities
- S3-compatible storage and authorized proxy
- Asaas adapter/webhook
- Domain events and audit logs
- Append-only revenue-quality ledger
- Permissioned AI assistance
- CSV import/undo

The permanent implementation order is:

> real workflow → correct minimum data → traceability → dashboard → intelligence

## 5. Release states

### Code-tested

Requires:

- TypeScript check passes
- Unit and integration tests pass
- Production build passes
- Bundle budgets pass
- No committed secrets or production PII

### Demo-ready

Requires code-tested plus:

- Stable authenticated navigation in a disposable environment
- Six golden paths execute without critical blockers
- UI does not claim unproven capabilities
- Exact commit SHA and run evidence are recorded

### Pilot-ready

Requires demo-ready plus:

- Isolated database migrations and seed are reproducible
- Role-based access is validated with at least admin, sales, reception and finance profiles
- Reception, sale, contract, payment simulation, commission and cancellation flows are validated end to end
- Backup/restore procedure is exercised on the disposable environment
- Gateway remains sandbox-only and reconciles idempotently
- Known issues have owner, severity and operational workaround

### Production-ready

Explicitly not claimed by this delivery. It additionally requires real-provider homologation, legal/privacy sign-off, production backup and recovery evidence, operational support, monitoring, incident response, data retention policy and controlled rollout.

## 6. Execution waves

### Wave 0 — Truth and reproducibility

- Record branch/base/missing local commit
- Create the audit plan and release ledger
- Open a draft pull request against the wave branch to run CI without mixing hundreds of historical commits into `main`
- Establish the remote baseline before code changes

### Wave 1 — CI and release governance

- Make CI reproducible on the audit branch and pull requests
- Pin runtime/tool versions consistently
- Add a release-readiness summary artifact
- Fail closed on configuration-shape errors, TypeScript errors, tests, build and budgets
- Keep authenticated E2E opt-in until an isolated database is available

### Wave 2 — Critical integrity audit

Audit existing high-risk flows against their tests and invariants:

1. authentication and capabilities;
2. storage authorization;
3. opportunity/proposal/discount lifecycle;
4. contract/installment/cancellation lifecycle;
5. gateway/webhook/reconciliation idempotency;
6. commission source and reversal logic;
7. reservation overlap, capacity and maintenance;
8. import transaction and protected undo.

Every confirmed defect receives a failing regression test before the fix.

### Wave 3 — Isolated end-to-end laboratory

- Validate that `E2E_DATABASE_URL` is mandatory and different from `DATABASE_URL`
- Make the isolated seed deterministic and prefixed `E2E-TGR-`
- Ensure cleanup is mandatory and verified
- Exercise the six golden paths
- Capture Playwright report and machine-readable receipt
- Never execute against a shared or production environment

### Wave 4 — Operational usability and accessibility

- Replace raw critical-policy editing where feasible with validated structured controls
- Preserve explicit `PENDENTE` states rather than inventing business defaults
- Validate loading, error, empty and truncated states
- Strengthen keyboard navigation, focus management, landmarks, labels and 200% zoom behavior
- Keep the sales-room five-second polling model unless strict realtime is justified by measured operational need

### Wave 5 — Release candidate and handoff

- Produce exact validation commands and results
- Publish known issues and blocked external homologations
- Produce a rollout checklist for controlled pilot users
- Request review on the draft PR
- Stop before merge to `main`, production deployment, real secrets or real database migration

## 7. Testing strategy

### Test-first rule

No production behavior change is allowed without a failing test that demonstrates the defect or required behavior first.

### Test layers

| Layer | Purpose |
|---|---|
| Pure domain tests | Lifecycle rules, scoring, money, dates and invariants |
| Router/integration tests | Authorization, transaction boundaries, idempotency and persistence contracts |
| Playwright E2E | Authenticated user journeys and browser behavior |
| CI configuration checks | Required configuration shape and secret-free defaults |
| Build/budget checks | Production compilation and performance regression limits |

### Golden paths

1. Capture → qualification → reception
2. Reception → table/team → presentation → close/no-tour
3. Opportunity → proposal → governed discount
4. Proposal → contract → installments → documents
5. Sandbox payment → reconciliation → commission → revenue quality
6. Customer 360 → cancellation/retention → entitlement/reservation history

## 8. Failure handling

- A failing baseline is investigated before any fix.
- Root cause is documented from logs, stack trace and recent changes.
- One hypothesis and one minimal change are tested at a time.
- Three failed fixes on the same issue trigger an architecture review instead of a fourth guess.
- External blockers are classified `BLOCKED`, not hidden or marked complete.

## 9. Security and data constraints

- No `.env`, access token, cookie, API key or customer PII enters Git.
- Storage reads require authentication and resource-level authorization.
- Financial and contractual writes remain idempotent, transactional and audited.
- AI cannot autonomously approve discounts, payments, commissions, cancellations or contracts.
- The TSE/tgsolutions repository is reference-only; no binary, data or code merge is permitted.
- Any migration is reviewed and exercised only in a disposable database during this delivery.

## 10. Definition of done for this branch

This branch is complete only when:

- the remote baseline and every subsequent correction have CI evidence;
- all introduced tests passed after first failing for the intended reason;
- code-tested gates are green;
- authenticated E2E is either green in a proven isolated environment or explicitly `BLOCKED` with exact missing secret/environment evidence;
- every external dependency is classified as `PASS`, `PARTIAL`, `BLOCKED` or `NOT_TESTED`;
- the draft PR contains reproducible commands, run links, known issues and rollback guidance;
- no merge, production deploy, real charge or real migration has occurred.

## 11. Final human gate

Only the following actions require a new explicit authorization after this autonomous execution:

- merge into `main`;
- deploy to production;
- bind real customer data;
- bind real Asaas/payment credentials;
- apply migration to shared/production data;
- enable irreversible external automation.
