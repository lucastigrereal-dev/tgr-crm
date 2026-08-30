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
