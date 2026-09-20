# TGR-CRM vNext — 48h Demo Readiness Implementation Plan

> **For agentic workers:** execute task-by-task with TDD, one review gate per task, small commits, no `git add .`, no push to `main` without explicit approval. Use an isolated branch/worktree. Do not touch production data or real payment credentials.

**Goal:** turn the existing `lucastigrereal-dev/tgr-crm` into a coherent, presentation-ready TGR-CRM demo in 48 hours, while removing the most dangerous legacy semantics that could misrepresent the product.

**Architecture:** preserve the current modular monolith (React/Vite + Express/tRPC + Drizzle/MySQL). Do not rewrite the stack. Change only what is required to establish canonical TGR identity, business truth, access safety, typed project rules, executive UX, isolated demo data, a stable preview, and six tested golden paths.

**Tech Stack:** React 19, Vite 7, Tailwind/Radix, Wouter, TanStack Query/tRPC 11, Express 5, Drizzle/MySQL, Zod 4, Vitest, Playwright.

**Spec:** PRD/Blueprint TGR-CRM v1, 24/08/2026.

## Global constraints

- Current Natal premises are authoritative; historical values are benchmark only.
- Do not invent MDR, anticipation rate, final commission percentages, operation months, e-sign provider, or card provider.
- Commission automation must fail closed when a valid project policy is absent.
- Proposal acceptance must never equal validated sale.
- No real PII in demo fixtures.
- No real payment credentials in demo.
- No feature claims without code/test evidence.
- AI may recommend but may not execute critical money/contract actions.
- First objective is Demo Ready, not full Production Ready.

---

## Task 1 — Freeze scope and baseline

**Files:** `DEMO_RUNBOOK.md`, `todo.md`.

- [x] Register current main SHA and create `demo-ready-2026-08-26`.
- [x] Freeze the six golden paths and the “Not in 48h” list.
- [ ] Run `pnpm check`, `pnpm test`, `pnpm build` in an execution environment.
- [ ] Record baseline results before feature work is considered releasable.

**Acceptance:** scope cannot silently grow and baseline is reproducible.

## Task 2 — Canonical TGR identity

**Files:** `package.json`, `architecture.md`, `client/src/components/DashboardLayout.tsx`, runtime copy containing `TSE`.

- [ ] Rename package to `tgr-crm`.
- [ ] Rewrite architecture around the TGR modular monolith and multi-project operation.
- [ ] Remove user-visible TSE/clone/reference language from runtime.
- [ ] Keep clean-room research as evidence, not product identity.
- [ ] Replace remaining English runtime copy such as `Sign out`.
- [ ] Remove internal joke copy from presentation-facing screens.

**Acceptance:** executives encounter only TGR-CRM product language.

## Task 3 — Storage access control

**Files:** `server/_core/storageProxy.ts`, access helpers, `server/storageAccess.test.ts`.

- [ ] Test unauthenticated document access → 401.
- [ ] Test authenticated out-of-scope document access → 403.
- [ ] Authenticate before creating signed URL.
- [ ] Authorize resource/key scope server-side.
- [ ] Audit sensitive document reads without logging contents.

**Acceptance:** possession of a storage key is insufficient to download a document.

## Task 4 — Sale truth

**Files:** `server/routers/sales.ts`, `server/routers/contracts.ts`, `shared/domainEvents.ts`, `server/saleLifecycle.ts`, tests.

- [ ] Prove approved proposal is not a validated sale.
- [ ] Separate commercial won state from signed/validated/paid facts.
- [ ] Introduce canonical terminology: proposal accepted, contract signed, validation pending, validated, payment confirmed.
- [ ] Remove any automatic transition that falsely presents approval as final sale.
- [ ] Add domain events only for actions the system can actually prove.

**Acceptance:** proposal acceptance cannot inflate validated sales/cash KPIs.

## Task 5 — Commission safety and Natal policy

**Files:** `server/commissionLifecycle.ts`, `server/commissionAutomation.ts`, `server/projectPolicy.ts`, `server/routers/commissions.ts`, payment webhook, tests.

- [ ] Automatic commission with incomplete policy must block.
- [ ] Remove historical hardcoded rates as production fallback.
- [ ] Policy must carry pending rates, cutoff day, payout day, eligible methods and basis.
- [ ] Natal principle: commission follows eligible receipt of entry, without inventing final rates.
- [ ] PIX/debit/credit timing must be policy-driven.
- [ ] Gateway webhook cannot generate commission with incomplete policy.

**Acceptance:** hidden historical percentages cannot pay Natal commissions.

## Task 6 — Typed Project Settings

**Files:** `shared/projectPolicySchemas.ts`, policy parser/router, `ProjectSettings.tsx`, feature forms.

- [ ] Zod schemas for commission, cancellation, capture requirements, documents and commercial roles.
- [ ] Parse existing stored JSON and expose validation state.
- [ ] Replace raw JSON as primary admin UX with forms.
- [ ] Show explicit `Pendente` state for undecided Natal parameters.
- [ ] Add admin-only Configurações navigation.

**Acceptance:** non-programmer admin can configure the project without editing JSON.

## Task 7 — Executive UX/navigation

**Files:** layout, Home, Sales, Capture, Team, routes if needed.

- [ ] Reorder information architecture around daily work.
- [ ] Keep route compatibility where possible.
- [ ] Replace `won/Fechadas` labels when they imply validated revenue.
- [ ] Remove internal-development copy from golden path screens.
- [ ] Honest implementation/sandbox/beta labels only when useful.
- [ ] Validate loading/empty/error states and 390px layout.

**Acceptance:** first-time executive understands the app in under two minutes.

## Task 8 — Resettable demo data

**Files:** `scripts/seed-demo.mjs`, `scripts/reset-demo.mjs`, `.env.example`, runbook.

Seed synthetic stories: qualified prospect, proposal pending, contract pending validation, validated contract with paid entry, overdue collection case, cancelled case, plus owner/reservation if supported.

- [ ] Require explicit demo DB guard.
- [ ] Refuse production-like target.
- [ ] Synthetic/non-real PII only.
- [ ] Reset removes tagged demo records only.

**Acceptance:** deterministic demo can be reset in minutes without touching production.

## Task 9 — Golden-path E2E

**File:** `e2e/demo-golden-paths.authenticated.spec.ts`.

- [ ] Dashboard/authentication.
- [ ] Capture/household.
- [ ] Opportunity/proposal/discount governance.
- [ ] Contract/installments.
- [ ] Finance/collection/commission.
- [ ] Customer 360° and reservation/right when available.

**Acceptance:** one command proves presentation path against isolated data.

## Task 10 — Stable preview

- [ ] Select a host compatible with the current Express/tRPC/MySQL architecture.
- [ ] Do not force a Vercel serverless rewrite inside the 48h window.
- [ ] Isolated demo DB and credentials.
- [ ] Verify all golden path routes from a second device.
- [ ] Record URL and rollback instructions.

**Acceptance:** demo URL survives a complete rehearsal.

## Task 11 — Release gate

Run, in order:

```bash
pnpm check
pnpm test
pnpm build
pnpm test:performance
pnpm test:browser
```

When isolated infrastructure is available:

```bash
pnpm test:e2e:isolation
```

**Acceptance:** no critical golden-path defect, no TypeScript error, no real secret/PII, no unsupported feature claim.

## Task 12 — Presentation freeze

**Files:** `DEMO_RUNBOOK.md`, `DEMO_CAPABILITIES.md`.

Capabilities document has exactly: `Implementado e demonstrável`, `Integração preparada`, `Roadmap`.

- [ ] 10–15 minute script with exact routes and synthetic records.
- [ ] Screenshots only after live preview works.
- [ ] Rehearse on desktop and second network/device.
- [ ] Freeze after last successful rehearsal except blocker fixes.
- [ ] Record exact commit SHA used in presentation.

**Acceptance:** presenter can distinguish real capability from prepared integration and roadmap.

---

## After presentation

### Production Safety & Business Truth
Capability RBAC/scopes, access logs, full sale-validation state machine, transactional outbox, backup/restore, CI/release gates, typed/versioned policy lifecycle.

### TSE Capability Parity
Fraction inventory/hold, e-sign, card/anticipation ledger, recurring payment if required, owner portal, D0-D180 post-sale, integration health center.

### Vanguard / TGR Differentiation
Metric dictionary/cohorts, gross/net VPG, healthy-revenue channel economics, workflow engine, forecast accuracy, AI evaluation/risk models, governed conversation intelligence.
