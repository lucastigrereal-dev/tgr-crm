# TGR CRM Remote Baseline — 2026-08-29

## Scope

- Product: TGR CRM only
- Delivery branch: `audit-delivery-2026-08-29`
- Remote base: `wave1-security-performance-2026-08-25`
- Base SHA: `97eb948bc5311c065e68912e343d8b77dc524c5a`
- Audited head SHA: `3cad31adbb02a11ee2f6514569f8ce20711589a6`
- Draft PR: `#1`
- Workflow: `TGR CRM CI`
- Run ID: `33263813145`
- Quality job ID: `99130173909`

## Result

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
| Authenticated E2E | BLOCKED | Job remains opt-in and was skipped |

## Root cause

The workflow config passes `version: 10.4.1` to `pnpm/action-setup@v4`, while `package.json` declares:

```json
"packageManager": "pnpm@10.26.2"
```

The setup action fails closed when two different pnpm versions are specified:

```text
Error: Multiple versions of pnpm specified:
- version 10.4.1 in the GitHub Action config
- version pnpm@10.26.2 in package.json
```

This is a CI configuration defect, not a TypeScript, test or application failure. No application gate was reached.

## Minimal correction hypothesis

Remove the duplicated hard-coded pnpm version from both workflow jobs and let `pnpm/action-setup@v4` use the repository-authoritative `packageManager` declaration.

This is preferable to changing `package.json`, because the lockfile and local tooling already identify `pnpm@10.26.2` as the project version.

## Secondary observation

The runner reports that actions targeting Node.js 20 are being forced to Node.js 24. This is a warning, not the cause of the failure. It will be addressed separately only after the baseline reaches the application gates.
