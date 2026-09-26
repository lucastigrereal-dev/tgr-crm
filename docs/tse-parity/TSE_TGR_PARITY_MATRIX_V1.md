# TSE -> TGR Parity Matrix V1

**Data:** 2026-09-26  
**Status:** auditoria funcional fechada para o escopo disponível  
**Objetivo:** provar, capacidade por capacidade, como a TGR Commercial Suite substitui o TSE/TSExplorer sem reconstruir a interface legada.

## Regra-mãe

O **TGR CRM é o sucessor canônico do TSE/TSExplorer**. Sales Command, Relationship, Online Recovery, Financial Layer e Portal do Proprietário são módulos especializados da mesma arquitetura. Uma função do TSE não precisa morar na interface do CRM, mas precisa ter **um dono TGR, uma fonte de verdade, integração comprovável e critério de aceite**.

Nenhuma capacidade é considerada substituída apenas porque existe uma tabela ou uma tela. Para o corte do TSE, o fluxo crítico precisa ter prova ponta a ponta.

## Fontes usadas

1. `.analysis_reference/engenharia_reversa.md` - endpoints do TSE Marketing, entidades de domínio e fluxo reconstruído.
2. `.analysis_reference/tsexplorer_latest_listing.txt` - inventário passivo do pacote TSExplorer.
3. `AUDITORIA_TSE_BENCHMARK_EM_ANDAMENTO.md` - 16 blocos funcionais e requisitos derivados.
4. Código atual do `tgr-crm` em `main` na base `c9c2e10`.
5. Código atual do `tgr-commercial-suite` em `main` para Sales Command, Relationship e Online Recovery.
6. PR `tgr-commercial-suite#12` para Financial Layer, explicitamente tratado como **não entregue enquanto estiver aberto/vermelho**.
7. Evidência histórica na Biblioteca: `PROVA_TSE_2025_CONTROLE_SALA.txt`, que confirma 1.433 linhas de vendas, 505 IdCasal e 103 campos do Controle de Sala. A lista 1:1 dos 103 campos não está disponível no repositório atual, portanto a paridade de campos permanece um gate de migração, não uma inferência.

## Legenda

- **SUPERIOR**: capacidade implementada com controles adicionais relevantes em relação ao TSE.
- **PARIDADE**: capacidade funcionalmente coberta.
- **PARCIAL**: existe base real, mas falta parte do fluxo, integração, profundidade ou prova.
- **AUSENTE**: não foi encontrada implementação atual suficiente.
- **P0**: bloqueia declaração formal de substituição/cutover.
- **P1**: necessário para operação madura, pode entrar por wave controlada.
- **P2**: melhoria ou compatibilidade não bloqueante no escopo atual.

## Resumo

- Capacidades auditadas: **58**
- SUPERIOR: **36**
- PARIDADE: **1**
- PARCIAL: **13**
- AUSENTE: **8**
- Gaps P0 ainda abertos: **10**

## Matriz canônica

| Domínio | Capacidade TSE / requisito | Dono TGR | Interface / integração | Status | Implementação atual | Evidência | Gap / aceite restante | Pri. |
|---|---|---|---|---|---|---|---|---|
| Identidade e contexto | Login do operador | TGR CRM | CRM + Sales Command | SUPERIOR | Autenticação, RBAC no servidor e escopo por projeto/papel; Sales Command possui contas por função. | client/src/components/DashboardLayout.tsx; server/routers/access.ts; apps/sales-command/server/src/auth/* | Nenhum gap funcional crítico para o corte do TSE. | P2 |
| Identidade e contexto | Empresa / unidade de negócio permitida | TGR CRM | CRM | PARCIAL | TSE permitia selecionar empresa e unidade; CRM atual trabalha por resort/projeto e papéis, adequado à operação atual. | drizzle/schema.ts: resorts, commercialProjectSettings; .analysis_reference/engenharia_reversa.md §2.3 | Se houver operação multiempresa real, modelar company/businessUnit; não bloquear Natal enquanto houver uma única empresa operacional. | P2 |
| Dados mestres | Profissões, UF, cidade, bandeira, veículo, locais | TGR CRM | CRM / Sales Command | PARCIAL | O TSE tinha lookups controlados. O TGR captura grande parte dos dados, mas vários são texto livre. | client/src/pages/Capture.tsx; drizzle/schema.ts captureRecords | Criar dicionários/versionamento para campos que precisam análise e padronização, sem engessar UX. | P1 |
| Captação | Ficha de casal e qualificação | TGR CRM | Sales Command -> CRM | SUPERIOR | Ficha atual inclui casal, renda, veículo, cartão, moradia, viagens, hotel, origem, campanha, brinde e qualificação. | drizzle/schema.ts captureRecords; client/src/pages/Capture.tsx | Fechar paridade campo a campo contra a matriz histórica de 103 campos. | P0 |
| Captação | Captação offline | Sales Command | Sales Command -> CRM | SUPERIOR | Fila local, estados pendente/sincronizando/conflito e revisão estão implementados. | client/src/lib/captureOfflineQueue.ts; CAPTURE_OFFLINE_VALIDATION.md; Sales Command offline survey/scan | Provar sincronização em aparelho real no piloto. | P1 |
| Captação | Agendamento de tour | TGR CRM | CRM / Sales Command | SUPERIOR | scheduledAt, tarefa automática, recepção e check-in fazem parte do fluxo atual. | drizzle/schema.ts captureRecords; server/routers/captures.ts | Executar E2E estrito contra banco isolado, já pendente no todo. | P0 |
| Captação | Ranking e desempenho de captador | Sales Command | Sales Command / CRM Analytics | SUPERIOR | Há self-performance, leader metrics, scorecards e análise por origem/captador. | apps/sales-command/client/src/features/metrics/*; client/src/pages/SalesAnalytics.tsx | Validar regras finais de reconhecimento sem premiar volume ruim. | P1 |
| Captação | SMS / mensageria utilitária | Relationship | Relationship / Online Recovery | AUSENTE | O TSE expunha envio SMS; os módulos TGR ainda não têm provider de comunicação automatizada homologado. | apps/relationship/README.md; apps/online-recovery/README.md | Conectar provedor WhatsApp/SMS/e-mail com consentimento, opt-out, idempotência e auditoria. | P1 |
| Sala | Check-in e chegada | Sales Command | Sales Command -> CRM | SUPERIOR | Recepção, QR, check-in e estados de jornada existem no Sales Command; CRM também registra checkedInAt. | apps/sales-command/client/src/features/reception/ReceptionPage.tsx; drizzle/schema.ts captureRecords | Executar o E2E de recepção contra banco isolado. | P0 |
| Sala | Fila e distribuição para consultor | Sales Command | Sales Command | SUPERIOR | Room board, consultant claim concorrente, waiting time e realtime estão implementados/testados. | apps/sales-command/client/src/features/room/RoomBoard.tsx; server/test/consultant-claim.concurrent.integration.test.ts; realtime-socket test | Validar política operacional de distribuição e exceções no piloto. | P1 |
| Sala | Cronômetro de tour / apresentação | Sales Command | Sales Command -> CRM | SUPERIOR | Estados de início/fim, duração e scanner/tour-time estão no Sales Command e CRM captura timestamps. | apps/sales-command/client/src/features/scanner/tour-time.ts; drizzle/schema.ts captureRecords | Piloto físico. | P1 |
| Sala | NT / no-tour | Sales Command | Sales Command -> CRM / Recovery | SUPERIOR | Há fluxo NT antes/depois de scan, responsabilidade e testes E2E; no-sale alimenta Recovery. | apps/sales-command/e2e/nt.spec.ts; apps/online-recovery/README.md | Validar taxonomia final de motivos. | P1 |
| Comercial | Oportunidade e funil | TGR CRM | CRM | SUPERIOR | Oportunidades têm lifecycle explícito, campanha, seller, valor esperado, won/lost e eventos. | drizzle/schema.ts opportunities; shared/opportunityLifecycle.ts | Nenhum gap TSE crítico identificado. | P2 |
| Comercial | Proposta, entrada e parcelamento | TGR CRM | Sales Command -> CRM | SUPERIOR | Proposta separada de venda, entrada e número de parcelas; Sales Command só oficializa após SALE_CONFIRMED. | drizzle/schema.ts proposals; apps/sales-command/client/src/features/closing/SaleForm.tsx | Homologar seam em piloto integrado. | P0 |
| Comercial | Aprovação de desconto | TGR CRM | CRM | SUPERIOR | Há proposalDiscountApprovals e trilha auditável. | drizzle/schema.ts proposalDiscountApprovals; server/routers/sales.ts | Configurar alçadas reais por projeto. | P1 |
| Comercial | Metas por operação/equipe | TGR CRM | CRM / Sales Command | SUPERIOR | salesGoals, progresso de campanhas e painéis de performance existem. | drizzle/schema.ts salesGoals; client/src/pages/Campaigns.tsx | Amarrar regras finais de meta ao projeto Natal. | P1 |
| Contratos | Lifecycle contratual | TGR CRM | CRM | SUPERIOR | Estados explícitos, transições protegidas e eventos; venda, contrato e caixa são fatos distintos. | drizzle/schema.ts contracts; shared/contractLifecycle.ts; architecture.md | Executar E2E completo com dados preenchidos. | P0 |
| Contratos | Reajuste monetário/indexadores | TGR CRM | CRM + Financial Layer | AUSENTE | O TSE tinha regra de contrato passível de reajuste; não há motor versionado de INCC/IGP-M/regras de reajuste no schema atual. | drizzle/schema.ts contracts/commercialPolicyVersions; .analysis_reference/engenharia_reversa.md §2.4 | Criar política de indexação versionada, calendário, base, memória de cálculo e lançamentos auditáveis. | P0 |
| Contratos | Documentos do contrato | TGR CRM | CRM | SUPERIOR | Storage privado, documentos obrigatórios por projeto, upload e auditoria estão implementados. | drizzle/schema.ts contractDocuments; server/routers/contracts.ts; server/storageAccess.ts | Homologar documentos reais e retenção/LGPD. | P1 |
| Contratos | Assinatura eletrônica | TGR CRM | CRM + provedor externo | PARCIAL | O CRM registra documento assinado de forma administrativa, mas não há adapter DocuSign/Clicksign/AssineOnline com envelope/webhook. | server/routers/contracts.ts markDocumentSigned; server/contracts.document-signature.test.ts | Implementar adapter, envelopeId, status, webhook idempotente, expiração/recusa e reconciliação. | P0 |
| Estoque comercial | Cota/fração vendável | TGR CRM | CRM | AUSENTE | O TSE tinha ciclo de vida explícito da cota; o TGR possui units de hospedagem e entitlements, mas não entidade de fração comercial vendável/reservada/vendida. | drizzle/schema.ts: units, contracts, ownershipEntitlements; .analysis_reference/engenharia_reversa.md §2.4 | Criar commercialFractions e lifecycle disponível/reservada/vendida/bloqueada/cancelada-retornada. | P0 |
| Estoque comercial | Reserva temporária de cota durante proposta | TGR CRM | CRM / Sales Command | AUSENTE | Não foi encontrada trava comercial de fração vinculada à proposta/fechamento. | drizzle/schema.ts proposals/contracts | Criar hold com TTL, owner, motivo, expiração e concorrência otimista. | P0 |
| Estoque comercial | Mapa de estoque e disponibilidade de venda | TGR CRM | CRM | AUSENTE | Há mapa de unidades para hospedagem, não mapa de 3.120 cotas comerciais do produto Natal. | client/src/pages/Reservations.tsx; drizzle/schema.ts units | Painel de estoque comercial com UH, fração, status, preço/tabela e drill-down. | P0 |
| Financeiro | Parcelas do contrato | TGR CRM | CRM | SUPERIOR | Installments, status, vencimento, pagamento e integração de cobrança existem. | drizzle/schema.ts installments; server/routers/finance.ts | E2E com gateway homologado. | P0 |
| Financeiro | PIX/Boleto com baixa automática | TGR CRM | CRM -> Financial Layer | PARCIAL | Adapter Asaas, QR/linha digitável e webhook idempotente estão implementados; credenciais reais/homologação seguem pendentes. | server/paymentGateway.ts; server/paymentGatewayWebhook.ts; PAYMENT_GATEWAY_DECISION.md | Homologar sandbox/produção, callbacks, chargeback/estorno e contingência. | P0 |
| Financeiro | Conciliação | TGR CRM | CRM + Financial Layer | SUPERIOR | Há reconciliação auditável, billing records e eventos financeiros. | server/finance.reconciliation.test.ts; server/routers/finance.ts | Conectar adquirentes/bancos reais no Financial Layer. | P1 |
| Financeiro | Renegociação | TGR CRM | CRM / Financial Layer | SUPERIOR | installmentRenegotiations, simulação/fluxo e UI existem. | drizzle/schema.ts installmentRenegotiations; client/src/components/RenegotiationDialog.tsx | Validar política real e efeitos contábeis. | P1 |
| Financeiro | Cobrança e carteira | TGR CRM | CRM + Relationship + Financial Layer | SUPERIOR | Fila de cobrança, dono de carteira, scorecards, preventiva no Relationship e eventos de risco existem. | server/finance.collection-queue-integrity.test.ts; financialPortfolioScorecard.ts; apps/relationship/README.md | Fechar integração Financial -> Relationship após PR Financial verde. | P0 |
| Financeiro | Ledger e DRE gerencial | Financial Layer | Financial Layer + CRM | PARCIAL | CRM já possui revenueQualityLedger e DRE; Financial Layer V1 está em PR aberto e não deve ser tratado como entregue. | server/revenueQualityLedger.ts; server/financeDre.ts; tgr-commercial-suite PR #12 | Deixar PR #12 verde, merge autorizado posteriormente, validar com financeiro humano. | P0 |
| Comissões | Comissão por papel e parcela recebida | TGR CRM | CRM | SUPERIOR | Comissão é gerada com origem em parcela, idempotência e lifecycle; baixa do Asaas pode disparar comissão. | server/commissionAutomation.ts; paymentGatewayWebhook.ts; salesCommissions schema | Configurar políticas reais do empreendimento. | P0 |
| Comissões | Split/cascata multipapel | TGR CRM | CRM | PARCIAL | Modelo atual é forte para liner/closer/FTB, mas não há árvore genérica supervisor/gerente/recaptura/unidade. | drizzle/schema.ts salesCommissions; commercialProjectSettings.commissionPolicy | Generalizar regra somente onde a operação realmente exigir, preservando política versionada. | P1 |
| Comissões | Borderô e fechamento | TGR CRM | CRM | SUPERIOR | Página de comissões, lifecycle, fechamento e scorecards estão versionados. | client/src/pages/Commissions.tsx; server/commissionLifecycle.ts | Validar calendário e alçadas reais. | P1 |
| Distrato | Solicitação e simulação | TGR CRM | CRM + Relationship | SUPERIOR | Pedido, snapshot de simulação, decisão humana e evidência de retenção estão modelados. | contractCancellationRequests; server/routers/contracts.ts; apps/relationship/README.md | E2E autenticado da interface ainda pendente. | P0 |
| Distrato | Execução com impactos | TGR CRM | CRM -> Financial / Relationship | SUPERIOR | Execução transacional cancela contrato, parcelas abertas, comissões não pagas, entitlements e cria impactos financeiros. | server/routers/contracts.ts; server/cancellationExecution.ts | Provar execução única em E2E e integração externa. | P0 |
| Cliente | Cadastro único | TGR CRM | CRM | PARIDADE | Cadastro de cliente único, documento único e ficha 360 existem. | drizzle/schema.ts customers; client/src/pages/CustomerDetail.tsx | Nenhum bloqueio central. | P2 |
| Cliente | Múltiplos telefones/e-mails/endereços e preferências | TGR CRM | CRM | AUSENTE | O TSE expunha endereço/telefone preferencial; TGR atual tem um telefone, um e-mail e um endereço principal por customer. | drizzle/schema.ts customers; .analysis_reference/engenharia_reversa.md §2.4 | Normalizar customerContacts/customerAddresses, preferencial, validade e histórico. | P1 |
| Cliente | Histórico de interações | Relationship | CRM + Relationship | SUPERIOR | CRM registra ligação/WhatsApp/e-mail/reunião/notas; Relationship adiciona jornada, sentimento e health score. | drizzle/schema.ts customerInteractions; apps/relationship/README.md | Conectar providers automáticos mantendo consentimento e escopo. | P1 |
| Pós-venda | Onboarding D1/D3/D5/D7 | Relationship | Relationship -> CRM | SUPERIOR | Relationship possui jornada inicial, next-best-action, health score, service recovery e retenção. | apps/relationship/README.md | Piloto integrado com CRM e Financial. | P0 |
| Recuperação | Não comprador / reativação | Online Recovery | Online Recovery -> Sales Command -> CRM | SUPERIOR | Fila, score, cadência, attempts, reativação, outbox/inbox e dead-letter estão implementados. | apps/online-recovery/README.md | UI completa e providers automáticos ainda fora da wave atual. | P1 |
| Utilização | Direito semana fixa/flutuante | TGR CRM | CRM + Relationship | SUPERIOR | Entitlements versionam fixed_week/flexible_week e prioridade, ligados a contrato/unidade/resort. | drizzle/schema.ts ownershipEntitlements; server/routers/ownership.ts | Validar regras jurídicas/comerciais de uso do produto Natal. | P1 |
| Utilização | Pontos | TGR CRM | CRM + Relationship | PARCIAL | Existe annualPoints e entitlement points, mas não ledger de crédito/débito/expiração/rollover por exercício. | ownershipEntitlements; client/src/pages/Reservations.tsx | Criar pointsLedger append-only e regras de validade, consumo, estorno e rollover. | P1 |
| Utilização | Intercâmbio / RCI | Relationship | Relationship + Portal + CRM | PARCIAL | Existe entitlement type exchange; não há jornada operacional nem adapter RCI/provedor equivalente. | ownershipEntitlements; .analysis_reference/engenharia_reversa.md §2.4 | Solicitação, débito de direito/pontos, parceiro, confirmação, voucher, cancelamento e reconciliação. | P1 |
| Reservas | Disponibilidade e reserva | TGR CRM | CRM + Portal | SUPERIOR | Calendário, disponibilidade, conflito, reserva e lifecycle existem. | client/src/pages/Reservations.tsx; server/routers/operations.ts | Portal deverá expor subset seguro ao proprietário. | P1 |
| Reservas | Lista de espera | TGR CRM | CRM + Portal | SUPERIOR | Waitlist priorizada e conversão em reserva confirmada estão implementadas. | reservationWaitlist schema; WaitlistDialog.tsx; operations.waitlist.conversion.test.ts | Expor experiência segura no Portal. | P1 |
| Reservas | Check-in/out e acompanhantes | TGR CRM | CRM + Portal/Relationship | SUPERIOR | Acompanhantes e presença individual, check-in e check-out estão implementados. | reservationGuests; client/src/pages/Reservations.tsx | Validar operação hoteleira real/PMS. | P1 |
| Reservas | Manutenção/bloqueio de unidade | TGR CRM | CRM / PMS | SUPERIOR | Bloqueio por manutenção impede conflito com reserva ativa. | unitMaintenanceBlocks; server/routers/ownership.ts | Sincronizar com PMS quando houver. | P1 |
| Proprietário | Portal de autosserviço | Portal do Proprietário | Portal + CRM + Relationship | AUSENTE | Não foi encontrado app de portal externo na suíte atual. | tgr-commercial-suite main tree; tgr-crm client routes | Criar portal separado com contrato, parcelas/2ª via, documentos, direitos, reservas, solicitações e benefícios. | P0 |
| Brindes | Voucher / brinde com lifecycle | TGR CRM | Sales Command + CRM | PARCIAL | A ficha registra giftDescription, mas não há entidade voucher com custo, parceiro, validade, emissão e uso. | captureRecords.giftDescription | Criar vouchers/gifts auditáveis e ligar custo/tour/venda/qualidade D90. | P1 |
| Relatórios | Dashboard executivo e drill-down | TGR CRM | CRM + Sales Command + Financial | SUPERIOR | Torre, analytics, filtros por campanha/sala/equipe/status, scorecards e Sales Command em tempo real superam o grid legado. | client/src/pages/Home.tsx; SalesAnalytics.tsx; Sales Command metrics/* | Financial Layer precisa completar recortes de caixa/orçamento após estabilização. | P1 |
| Relatórios | Grids, pivôs, impressão e exportação ad hoc | TGR CRM | CRM / BI | PARCIAL | TSE era forte em grids/pivôs/print. TGR tem dashboards, filtros e algumas exportações, mas não foi encontrada uma camada genérica de pivot/report builder. | AUDITORIA_TSE_BENCHMARK_EM_ANDAMENTO.md; client pages | Definir relatórios operacionais obrigatórios; evitar recriar 759 telas só por paridade visual. | P2 |
| Integrações | Contrato de eventos e isolamento | TGR CRM | CRM / Suite | SUPERIOR | tgr.events.v1 com allowlist, eventos append-only e sem escrita cruzada direta. | INTEGRATION_CONTRACT_V1.md; shared/integrationContract.ts | Padronizar project.externalKey em todos produtores. | P0 |
| Integrações | PMS / ERP | TGR CRM | CRM adapters | AUSENTE | Arquitetura prevê adapters, mas não há conector PMS/ERP real no main atual. | AUDITORIA_TSE_BENCHMARK_EM_ANDAMENTO.md; server/routers/integrations.ts | Escolher PMS/ERP alvo, health check, idempotência, reconciliação, retry e dead-letter. | P1 |
| Integrações | Observabilidade e fila operacional | Commercial Suite | CRM + Suite | PARCIAL | Recovery possui backlog/dead-letter e health operacional; CRM expõe feed, mas não há torre única de integrações da suíte. | apps/online-recovery/README.md; server/routers/integrations.ts | Criar Integration Operations Console com processados/falhos/retry/dead-letter/idade/reconciliação. | P1 |
| Segurança | RBAC, auditoria e PII | TGR CRM | Todos | SUPERIOR | Autorização server-side, audit logs, storage protegido, event allowlists e testes de acesso são explícitos. | architecture.md; server/access.test.ts; server/storageAccess.ts | Revisão LGPD e perfis finais antes de produção. | P0 |
| Dados | Importação/migração | TGR CRM | CRM | PARCIAL | Há CSV import e infraestrutura de migração, mas o universo histórico do TSE não está reconciliado integralmente. | client/src/pages/ImportCsv.tsx; csvImportBatches/items; PROVA_TSE_2025_CONTROLE_SALA | Localizar/exportar fonte principal, mapear 103 campos, reconciliar totais e preservar lineage. | P0 |
| Dados | Paridade dos 103 campos do Controle de Sala | TGR CRM | CRM + Sales Command | PARCIAL | A Biblioteca confirma 103 campos mapeados no artefato histórico; o TGR tem ficha rica, mas a lista fonte dos 103 não está materializada neste repositório para confronto 1:1. | PROVA_TSE_2025_CONTROLE_SALA; drizzle/schema.ts captureRecords | Obrigatório anexar/recuperar a matriz fonte e fechar cada campo como MAPEADO/TRANSFORMADO/DESCARTADO COM JUSTIFICATIVA. | P0 |
| Operação | Backup/restore de piloto | TGR CRM | CRM / Suite | SUPERIOR | Runtime de piloto possui MySQL persistente e scripts de backup/restore; Sales Command também tem drill validado. | infra/pilot/*; docs/PILOT_RUNTIME_RECEIPT.md no suite | Produção exige backup externo, RPO/RTO e restore drill operacional. | P1 |
| Experiência | Web/mobile responsivo | Commercial Suite | CRM + Sales Command + Portal | SUPERIOR | CRM é responsivo; Sales Command tem interfaces operacionais e offline para campo. | client/src/hooks/useMobile.tsx; Sales Command client/* | Validar aparelhos físicos e legibilidade em campo. | P1 |

## Bloqueadores P0 derivados da matriz

1. **Reajuste monetário/indexadores** (AUSENTE): Criar política de indexação versionada, calendário, base, memória de cálculo e lançamentos auditáveis.
2. **Assinatura eletrônica** (PARCIAL): Implementar adapter, envelopeId, status, webhook idempotente, expiração/recusa e reconciliação.
3. **Cota/fração vendável** (AUSENTE): Criar commercialFractions e lifecycle disponível/reservada/vendida/bloqueada/cancelada-retornada.
4. **Reserva temporária de cota durante proposta** (AUSENTE): Criar hold com TTL, owner, motivo, expiração e concorrência otimista.
5. **Mapa de estoque e disponibilidade de venda** (AUSENTE): Painel de estoque comercial com UH, fração, status, preço/tabela e drill-down.
6. **PIX/Boleto com baixa automática** (PARCIAL): Homologar sandbox/produção, callbacks, chargeback/estorno e contingência.
7. **Ledger e DRE gerencial** (PARCIAL): Deixar PR #12 verde, merge autorizado posteriormente, validar com financeiro humano.
8. **Portal de autosserviço** (AUSENTE): Criar portal separado com contrato, parcelas/2ª via, documentos, direitos, reservas, solicitações e benefícios.
9. **Importação/migração** (PARCIAL): Localizar/exportar fonte principal, mapear 103 campos, reconciliar totais e preservar lineage.
10. **Paridade dos 103 campos do Controle de Sala** (PARCIAL): Obrigatório anexar/recuperar a matriz fonte e fechar cada campo como MAPEADO/TRANSFORMADO/DESCARTADO COM JUSTIFICATIVA.

## Fronteiras canônicas da suíte

```text
Sales Command
  owns: execução viva da captação, recepção, sala, tour, NT e fechamento
  emits: fatos comerciais e operacionais
        |
        v
TGR CRM
  owns: cliente, oportunidade, proposta, contrato, parcela,
        cota/fração comercial, direito de uso, reserva, distrato,
        políticas e histórico canônico
   |                 |                    |
   v                 v                    v
Financial Layer   Relationship        Portal do Proprietário
money truth       pós-venda/risco     autosserviço externo
   ^                 ^
   |                 |
   +------ CRM events + Sales facts
```

Online Recovery permanece dono da recuperação de não compradores, devolvendo o casal para um novo ciclo comercial sem reabrir ou adulterar o NO_SALE histórico.

## Decisões desta auditoria

1. **Não recriar o TSE tela por tela.** A paridade é por capacidade, dado, regra e resultado.
2. **CRM continua fonte de verdade de cliente/contrato/reserva/distrato**, mesmo quando a experiência está em outro módulo.
3. **Sales Command não vira CRM.** Ele executa a operação e publica fatos.
4. **Financial Layer não substitui parcelas/contrato do CRM.** Ele aprofunda verdade monetária, DRE, orçamento, previsão e vazamentos.
5. **Portal é app separado**, mas não cria uma segunda base de cliente ou contrato.
6. **Financial Layer PR #12 não conta como entregue** enquanto não estiver verde/aceito.
7. **A matriz de 103 campos é obrigatória para cutover de dados.** Sem a lista fonte, não se pode declarar cobertura 1:1.
8. **Dados históricos não podem ser extrapolados da coorte parcial de 68 casais.** A migração precisa reconciliar a fonte principal.

## Definição de “TSE substituído”

O TSE só pode ser desligado quando:

- todo item P0 desta matriz estiver SUPERIOR ou PARIDADE, ou tiver exceção formal assinada;
- as integrações críticas estiverem homologadas;
- a migração tiver reconciliação quantitativa e financeira;
- os fluxos críticos tiverem E2E autenticado;
- houver backup/restore e rollback testados;
- usuários de operação não precisarem voltar ao TSE para executar nenhuma rotina necessária.

