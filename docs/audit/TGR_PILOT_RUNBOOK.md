# TGR CRM — Runbook de piloto controlado

## Pré-condições

1. Use somente o branch auditado e uma aprovação humana de merge.
2. Configure segredos fora do repositório; nunca reutilize variáveis de E2E.
3. Mantenha gateway real em estado BLOCKED até contrato operacional, webhook autenticado e credenciais próprias aprovadas.

## Validação de release

1. Confirme o SHA e ambos os jobs verdes do run `33291030111`.
2. Execute instalação congelada, `pnpm config:doctor`, `pnpm check`, `pnpm test`, `pnpm build` e orçamento de bundle.
3. Para homologação, use exclusivamente MySQL 8.4 descartável com `E2E_RUN_ID`, `E2E_CONFIRM_ISOLATED=I_CONFIRM_ISOLATED_E2E` e banco no formato de propriedade do run.
4. Aplique migrações, rode seed determinístico e os E2Es estritos.
5. Exija `cleanup-e2e-isolated.mjs` verde antes de encerrar a homologação.

## Critério de parada

- PASS: todos os gates acima e cleanup concluído.
- BLOCKED: segredo, infraestrutura ou regra de negócio ausente. Não substituir por dado fictício fora do banco isolado.
- Nunca executar esse roteiro contra produção ou banco compartilhado.

## Homologação local Windows

Use `scripts/run-e2e-windows-local.ps1` com um `RunId` único.

Exemplo: `pwsh ./scripts/run-e2e-windows-local.ps1 -RunId win_YYYYMMDD_a`.

O runner recusa porta de aplicação já ocupada, usa MySQL 8.4 descartável, executa migrations + seed + 5 jornadas Chromium e remove apenas o banco pertencente ao run. O critério de sucesso exige `WINDOWS_E2E=PASS` e `CLEANUP_EXIT=0`.
## Runtime persistente de piloto

Comandos:

- iniciar/reparar: `pwsh ./infra/pilot/start-pilot.ps1`
- status: `pwsh ./infra/pilot/status-pilot.ps1`
- renovar apenas o túnel: `pwsh ./infra/pilot/refresh-tunnel.ps1`
- backup + restore drill: `pwsh ./infra/pilot/backup-pilot.ps1`
- parar preservando volumes: `pwsh ./infra/pilot/stop-pilot.ps1`

Segredos e URL atual ficam somente em arquivos locais ignorados pelo Git:
- `infra/pilot/.env.pilot.local`
- `infra/pilot/.pilot-credentials.local.txt`
- `infra/pilot/.pilot-url.local.txt`

Critério de prontidão do piloto:
1. app e MySQL `healthy`;
2. `READY=PASS`;
3. `PUBLIC_TUNNEL=PASS`;
4. login local válido;
5. backup/restore drill verde.

Quick Tunnel é somente homologação. Para produção, use domínio/túnel nomeado e infraestrutura com SLA.