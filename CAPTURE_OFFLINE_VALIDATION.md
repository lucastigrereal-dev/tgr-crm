# Validação — Fila offline de captação

Em 21 de agosto de 2026, a Central de Captação foi conferida na rota correta `/captacao`. A ficha digital, o seletor de empreendimento e a fila de sala renderizam sem regressão visual. A faixa de sincronização offline permanece oculta quando não existem fichas pendentes, evitando ruído operacional no estado normal.

A implementação usa IndexedDB no navegador para persistir a carga da ficha, uma chave de deduplicação baseada em titular, telefone, empreendimento e horário, e reenvio ao retorno da conexão ou por ação explícita do operador. A deduplicação possui teste unitário; a simulação de navegador realmente offline e o conflito contra backend permanecem pendentes de prova específica.

## Prova com rede desligada (M-A15-02, 25/10/2026)

Decisão do Lucas: **só a ficha** funciona sem internet no celular do captador. Contrato, pagamento e venda continuam só online, e o consentimento do casal continua online pelo QR do GuestPass (não existe consentimento offline).

O que mudou: a ficha leva um `clientRequestId` (UUID gerado no aparelho, o mesmo `id` da fila local). O servidor grava uma trava única em `audit_logs` (`capture-create:<uuid>`, sem migration) no começo da criação; reenviar a mesma ficha (resposta perdida, duas abas, sincronização repetida) devolve a MESMA ficha. Falha de rede no meio do envio devolve a ficha a "pendente" (não vira conflito). Sincronizar fichas guardadas não apaga mais a ficha que o captador está digitando.

Prova: `e2e/capture-offline.authenticated.spec.ts` (Chromium real, `context.setOffline(true)`, servidor e banco descartáveis `tgr_crm_off1_e2e`): 1) sem rede a ficha vai para a fila local e nada chega ao banco; 2) com a rede de volta mas a resposta do servidor "perdida", o servidor grava e o aparelho não fica sabendo; 3) reabrir o app mantém a ficha na fila, ainda pendente; 4) sincronizar devolve a mesma ficha, esvazia a fila e o banco fica com **1 ficha só** (1 linha de trava). Rodar: `E2E_CAPTURE_OFFLINE=1 E2E_DATABASE_URL=... E2E_EXTERNAL_SERVER=1 pnpm exec playwright test e2e/capture-offline.authenticated.spec.ts`. Testes MySQL: `server/captureCreateIdempotency.mysql.test.ts` (reenvio, corrida de 3 tentativas, ids diferentes, falha sem deixar trava, id inválido recusado).

Fora do escopo desta missão: resolução de conflito de dados entre fichas (continua revisão humana pela faixa da fila) e a mensagem "salvo no celular / enviado" na tela do GuestPass (thread do GuestPass).
