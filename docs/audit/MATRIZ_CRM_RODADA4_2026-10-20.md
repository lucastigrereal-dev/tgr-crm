# CRM rodada 4, lote 4: matriz (2026-10-20)

Base: `main` e1de35c. Ramo `claude/crm-rodada4`. Regras mantidas: nada em banco real; migrações 0070 e 0071 só em MySQL descartável (não aplicadas em lugar nenhum); nenhum teste desligado; só dado sintético; comissão positiva TRAVADA; endpoint do NQ desligado; flags novas DESLIGADAS; o CRM não vira dono de dado de outro sistema.

| Item | Estado | Flag (padrão) | Prova local (MySQL 8.0 descartável) | Não provado |
| --- | --- | --- | --- | --- |
| CRM-A01 mapa por empreendimento | IMPLEMENTADO. Tabela `financial_project_map` (0070 + rollback); a ponte resolve contrato -> empreendimento -> projeto; sem linha, sem empreendimento ou sem contrato usa o projeto padrão; CSV de contratos aceita coluna opcional `empreendimento`; API admin com auditoria | `FINANCIAL_PROJECT_MAP_ENABLED=false` | `financialProjectMap.mysql` 4, `csvImport` unitário, `migrationRollback.mysql` | Financial real aceitando vários projetos (a Suite precisa cadastrar as chaves); contrato do evento NÃO mudou |
| CRM-A12 aditivo mínimo | IMPLEMENTADO desligado. Tabela `contract_addenda` (0071 + rollback); registrar, enviar a assinatura, aprovar com documento assinado, histórico, cancelar; sem valor, sem evento | `CONTRACT_ADDENDUM_ENABLED=false` | `addenda.mysql` 6, `migrationRollback.mysql` | telas; assinatura eletrônica do aditivo; titular, prazo e vigência (decisão de produto/jurídico) |
| CRM-A26 revisão de segurança | EXECUTADA; 4 achados tratados (ver `REVISAO_SEGURANCA_CRM_2026-10-20.md`) | `CSRF_ORIGIN_CHECK_ENABLED=false` | `securityReview.test` 4, `pnpm audit --prod` limpo | HTTPS real, teste de intrusão externo |
| CRM-A28 SHA na imagem | IMPLEMENTADO: `ARG GIT_SHA`, label OCI `org.opencontainers.image.revision`, `gitSha` em `/api/health` | n/a | `healthGitSha.test` 3 | build real da imagem (sem Docker aqui) |

Ordem de mudança de contrato: nenhum evento nem contrato mudou nesta rodada (o mapa só escolhe o projeto do envelope existente), portanto não há re-pin da Suite.

## Ordem de aplicação e operação

- As migrações 0070 e 0071 entram no lote D (aplicação em banco real) DEPOIS de 0061 a 0069, com aceite e backup antes. Nada foi aplicado em banco real nesta rodada.
- Depois de ligar `FINANCIAL_PROJECT_MAP_ENABLED`, NÃO trocar o projeto (externalKey) de um empreendimento que já tem contrato entregue ao Financial: os eventos antigos ficaram no projeto anterior e os novos iriam a outro. Para um empreendimento novo ou ainda sem contrato entregue, pode mapear livremente.
- As 4 flags novas (`FINANCIAL_PROJECT_MAP_ENABLED`, `CONTRACT_ADDENDUM_ENABLED`, `CSRF_ORIGIN_CHECK_ENABLED`, `CSRF_ALLOWED_ORIGINS`) estão no environment do serviço app do compose do piloto, desligadas por padrão (teste estático `pilotComposeFlags.test.ts`).
