# Monetary Adjustment V1

This branch implements the TSE-cutover monetary-adjustment capability without hard-coding any market index value.

## Safety invariants

- A policy version is explicit and immutable once used.
- Index values carry a source and reference date.
- Simulation is read-only.
- Application requires the literal confirmation `APPLY_REVIEWED_ADJUSTMENT`.
- Only `open` and `overdue` installments are eligible for mutation.
- Paid, cancelled and renegotiated installments are not changed.
- Each application stores a reproducible before/after calculation snapshot.
- A contract cannot receive the same `throughDate` adjustment twice.
- The engine never fetches or invents INCC, IGP-M or any other index automatically.

## External gate

Production use still requires an approved policy and a governed source for each index series.
