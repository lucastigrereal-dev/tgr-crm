# TGR CRM Remote Baseline — 2026-08-29

## Scope

- Product: TGR CRM only
- Delivery branch: `audit-delivery-2026-08-29`
- Remote base: `wave1-security-performance-2026-08-25`
- Base SHA: `97eb948bc5311c065e68912e343d8b77dc524c5a`
- Draft PR: `#1`

## Run 1 — failing infrastructure baseline

- Head SHA: `3cad31adbb02a11ee2f6514569f8ce20711589a6`
- Workflow run ID: `33263813145`
- Quality job ID: `99130173909`

| Gate | Result | Evidence |
|---|---|---|
| Checkout | PASS | PR merge ref checked out successfully |
| pnpm setup | FAIL | Conflicting pnpm declarations |
| Dependency install | NOT_TESTED | Skipped after setup failure |
| Configuration doctor | NOT_TESTED | Skipped after setup failure |
| TypeScript | NOT_TESTED | Skipped after setup failure |
| Unit/integration tests | NOT_TESTED | Skipped after setup failure |
| Production build | NOT_TESTED | Skipped after setup failure |
| Bundle budget | NOT_TESTED | Skipped after setup failure |
| Authenticated E2E | BLOCKED | Job remained opt-in and was skipped |

### Root cause

The workflow passed `version: 10.4.1` to `pnpm/action-setup@v4`, while `package.json` declared:

```json
"packageManager": "pnpm@10.26.2"
```

The setup action correctly failed closed because two different versions were specified.

### Correction

Removed the duplicated workflow pin and made the repository's `packageManager` declaration authoritative for both quality and E2E jobs.

## Run 2 — corrected remote quality baseline

- Head SHA: `4db53ca82fe24625143fb659ee537441a4fd37ff`
- Workflow run ID: `33263897632`
- Quality job ID: `99130395642`
- Duration: 2026-08-29 16:47:03Z to 16:48:23Z

| Gate | Result | Evidence |
|---|---|---|
| Checkout | PASS | Pull-request merge ref checked out |
| pnpm setup | PASS | Repository version resolved without conflict |
| Node setup | PASS | Node 22 configured |
| Frozen dependency install | PASS | Lockfile accepted |
| Configuration doctor | PASS | CI-safe JWT shape accepted |
| TypeScript | PASS | `pnpm check` |
| Unit/integration tests | PASS | Full configured Vitest suite |
| Production build | PASS | Client and server build |
| Bundle budget | PASS | Budget script completed |
| Authenticated E2E | BLOCKED | Conditional E2E job skipped because isolated environment is not enabled |

## Baseline verdict

**CODE-TESTED: PASS** on the remotely available branch after one CI configuration correction.

**DEMO/PILOT E2E: BLOCKED**, because authenticated Playwright validation has not yet run against a disposable database and controlled identity environment.

## Secondary observation

The runner warns that some GitHub actions targeting Node.js 20 are being forced to Node.js 24. This warning did not fail the job and is not an application defect. Action-version modernization can be handled separately after the E2E safety work.
