# TSE -> TGR Cutover Gates V1

**Data:** 2026-09-26  
**Dependência:** `TSE_TGR_PARITY_MATRIX_V1.md`

## Objetivo

Transformar “o TGR parece melhor” em uma decisão auditável de desligamento do TSE.

## Gate 0 - Autoridade e fronteiras

**PASS quando:** CRM, Sales Command, Relationship, Recovery, Financial e Portal têm ownership explícito e nenhuma entidade canônica possui dois donos.

- CRM: cliente, oportunidade, proposta, contrato, parcela, fração comercial, direito, reserva, distrato.
- Sales Command: execução da sala/captação.
- Relationship: pós-venda e retenção.
- Recovery: não comprador.
- Financial: verdade monetária gerencial.
- Portal: experiência externa, sem banco canônico independente.

## Gate 1 - Paridade funcional P0

**PASS quando:** todos os itens P0 da matriz estão PARIDADE/SUPERIOR ou têm waiver formal com prazo, owner e risco aceito.

Bloqueios atuais principais:
- estoque comercial de frações e hold;
- reajuste/indexadores;
- assinatura eletrônica real;
- portal do proprietário;
- gateway real homologado;
- Financial Layer integrado e verde;
- E2E de recepção/distrato;
- migração e matriz de 103 campos.

## Gate 2 - Dados históricos

**PASS quando:**
1. fonte principal de atendimentos do TSE é localizada ou ausência é documentada;
2. 103 campos do Controle de Sala têm decisão 1:1: MAPEADO, TRANSFORMADO ou DESCARTADO_COM_JUSTIFICATIVA;
3. clientes/casais são deduplicados;
4. contratos e parcelas reconciliam;
5. totais de VGV, recebimentos, cancelamentos e comissão reconciliam por período;
6. toda importação guarda `sourceSystem`, `sourceId`, batch, hash e timestamp;
7. amostras de reconciliação são assinadas por operação/financeiro.

A coorte parcial de 68 casais não pode ser usada como universo histórico.

## Gate 3 - Fluxo comercial E2E

Cenário mínimo:
```text
captação offline
-> sync
-> check-in
-> distribuição
-> tour
-> closer
-> proposta
-> entrada
-> SALE_CONFIRMED
-> CRM
-> contrato
```

**PASS quando:** nenhum refresh, retry ou queda de rede duplica casal, venda, entrada ou contrato.

## Gate 4 - Contrato e estoque

**PASS quando:**
- fração comercial é alocada de modo concorrente;
- proposta segura a cota por hold com expiração;
- contrato ativo consome a fração;
- distrato retorna fração conforme política;
- reajuste é calculado por política versionada;
- documento eletrônico percorre enviado -> visualizado -> assinado/recusado/expirado;
- toda mudança deixa trilha.

## Gate 5 - Financeiro

**PASS quando:**
- PIX/boleto homologados;
- webhook é idempotente;
- baixa de parcela cria fato financeiro uma vez;
- comissão só nasce/libera conforme política;
- renegociação, estorno e chargeback têm efeito explícito;
- CRM -> Financial está reconciliado;
- financeiro humano valida DRE/carteira/forecast do piloto.

## Gate 6 - Pós-venda, utilização e proprietário

**PASS quando:**
- Relationship recebe venda/contrato sem duplicar case;
- D1/D3/D5/D7 roda com dados controlados;
- rights/reservations estão coerentes;
- Portal exibe apenas dados do proprietário autenticado;
- 2ª via/documentos/reserva/solicitação funcionam;
- pontos/intercâmbio, quando habilitados no produto, usam ledger e não saldo mutável sem histórico.

## Gate 7 - Integrações

**PASS quando cada conector crítico possui:**
- health;
- TLS/segredo;
- idempotência;
- timeout;
- retry/backoff;
- dead-letter;
- reconciliação;
- replay controlado;
- dashboard de operação;
- owner e runbook.

## Gate 8 - Segurança e LGPD

**PASS quando:**
- RBAC final validado por papel;
- exportações respeitam escopo;
- PII é mascarada onde necessário;
- storage privado validado;
- logs não contêm cartão/segredos;
- consentimento/finalidade/retenção definidos;
- auditoria identifica quem viu/alterou/exportou quando aplicável.

## Gate 9 - Resiliência

**PASS quando:**
- backup externo existe;
- restore drill reproduz contagens;
- RPO/RTO aprovados;
- rollback de deploy documentado;
- indisponibilidade de um módulo não corrompe os outros;
- filas podem ser reprocessadas sem duplicidade.

## Gate 10 - Corte do TSE

Executar somente com GO humano explícito.

Plano:
1. congelar janela de migração;
2. export final TSE;
3. importar incremental;
4. reconciliar;
5. colocar TSE read-only;
6. operar TGR em hypercare;
7. monitorar 7/30 dias;
8. manter evidência de rollback;
9. desligar acesso operacional ao TSE somente após aceite.

## Critério final

**CUTOVER=PASS** somente se Gate 0 a Gate 9 estiverem PASS e o Gate 10 receber GO explícito.
