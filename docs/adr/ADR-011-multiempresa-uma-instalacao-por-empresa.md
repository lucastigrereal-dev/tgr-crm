# ADR-011 — Multiempresa: uma instalação por empresa

- Status: aceita (decisão do Lucas, 14/10/2026; registrada em 16/10/2026)
- Pacote: CRM-PK-03 (CRM-01)
- Base: confronto de opções em `/mnt/project-files/mandato/frente-a/MULTIEMPRESA_OPCOES_2026-10-14.md` (main 0c1506a)

## Contexto

O CRM conhece **resort** (empreendimento) e configurações de projeto por resort, mas não conhece **empresa**. O usuário tem só um papel (`drizzle/schema.ts`, `server/routers/access.ts`), sem vínculo com resort ou empresa. Das 51 tabelas, 35 não chegam a um resort pelos vínculos (clientes, oportunidades, contratos, parcelas, lançamentos, eventos, auditoria). A ponte com o Financial já assume **um projeto por instalação** (`server/_core/env.ts`). O MySQL não impede, sozinho, que uma consulta esqueça o filtro de empresa.

## Decisão

**Uma instalação = uma empresa.** Cada empresa nova ganha o próprio deploy e o próprio banco, a partir do modelo do piloto (`infra/pilot`). O código do CRM **não** ganha coluna de empresa nem filtro por empresa.

## Consequências

- Não existe caminho para dados de uma empresa vazarem para outra pelo CRM: o isolamento é o banco.
- Cada empresa custa mais para operar (backup, atualização, monitoramento próprios) e não há relatório que some empresas.
- A ponte Financial usa **um projeto por instalação** (`FINANCIAL_PROJECT_*`); eventos de resort fora desse projeto são recusados e ficam visíveis (CRM-PK-04).
- Dentro da instalação, vários resorts continuam possíveis (empreendimentos da mesma empresa). O resort passa a ser gravado no contrato (CRM-PK-04) para acabar com a dedução por cota/captação.
- GuestPass também segue uma instalação por empresa (GP-15).
- Revisitar a decisão se uma segunda empresa for assinada **e** pedir visão consolidada ou usuários que circulam entre empresas. Caminho então: opção (c) do confronto (empresa deduzida do resort), que o resort gravado no contrato já facilita.

## Roteiro: subir uma nova instalação (nova empresa)

1. Banco MySQL novo e vazio para a empresa (nunca reaproveitar o de outra). Aplicar as migrações do CRM (`pnpm exec drizzle-kit migrate`).
2. Variáveis da instalação: `DATABASE_URL`, `JWT_SECRET`, chaves das integrações próprias da empresa (Sales Command, Financial, Relationship) e `FINANCIAL_PROJECT_*` do projeto da empresa. Segredos ficam fora do repositório.
3. Cadastrar o(s) resort(s) e as configurações de projeto da empresa; criar os usuários por papel (modelo: `scripts/pilot-users.mjs`, que grava as senhas temporárias fora do repo).
4. Pontes: apontar cada bomba (Sales, Financial, Relationship) para as instâncias da mesma empresa; conferir o painel de integrações sem pendentes recusados.
5. Provar com dado sintético antes de qualquer dado real (modelo: `scripts/pilot-seed-sala.mjs` + `scripts/pilot-login-smoke.mjs`). Dado real, domínio e produção continuam sendo decisão do Lucas.
6. Registrar o recibo da instalação (SHA, quem executou, o que passou).

## Implementação do empreendimento no contrato (CRM-PK-04)

- `contracts.resortId` (migração `0059_contracts_resort_id.sql`): gravado na criação. A cota manda; sem cota, vale o único empreendimento da captação da proposta; a formalização do Sales Command grava o empreendimento da venda.
- Backfill dentro da própria migração, em duas etapas idempotentes: pela cota vendida (`commercial_fractions.currentContractId`) e pela captação da proposta, sempre só quando há exatamente um empreendimento. Contrato sem origem (por exemplo, importado por CSV sem cota) fica em branco; o reajuste monetário usa a dedução antiga só nesses casos e registra um aviso no log.
- Rollback testado: `docs/rollback/0059_contracts_resort_id.down.sql` (a FK sai antes do índice).
- Ponte Financial: continua com um único projeto por instalação (identidade vem da configuração). Não há mapa empreendimento→projeto porque uma empresa tem um projeto só; por isso o payload dos eventos não mudou e não há re-pin do crm-pair. Teste em `financialBridge.test.ts` fixa que todo evento sai com o mesmo projeto.
- Aplicar a migração em banco real continua sendo decisão do Lucas.
