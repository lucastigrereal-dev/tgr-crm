# Exclusão LGPD propagada: lado CRM (F2.10)

Fonte: `docs/design/ERASURE_PROPAGADA.md` do GuestPass (PR GuestPass #35, só desenho). Este documento descreve o que o CRM implementa; nada aqui está ligado ou homologado. Flag `PRIVACY_ERASURE_PROPAGATION_ENABLED` nasce OFF. Migration `PROPOSED_0088_privacy_erasure_propagation.sql` (PROPOSTA; 0087 é do vínculo GuestPass da #121).

## Fluxo
1. O job (a cada 15 min, só com flag ligada e endpoint https, chave e segredo configurados) puxa `GET <GUESTPASS_PRIVACY_BRIDGE_ENDPOINT>?limit=&after=` do GuestPass.
2. Cada evento `privacy.erasure.requested.v1` é validado (schema estrito do desenho) e gravado em `privacy_erasure_events` por `eventId` (idempotente, também em paralelo).
3. O CRM grava o evento INTERNO `privacy.erasure.requested` (payload só `eventId` e `mode`; fora das pontes Financial e Relationship) como ponto de fan-out para Sales, Recovery, Relationship e Financial.
4. O titular é achado por `HMAC-SHA256(CPF só dígitos, GUESTPASS_PRIVACY_BRIDGE_HMAC_SECRET)`; o CPF em claro nunca viaja nem é logado. Varredura por id em lotes (exclusão é rara; sem coluna nova indexada).
5. Cada cliente achado é anonimizado pela MESMA função do pedido de exclusão da ficha (`applyCustomerAnonymization`): ficam nome, CPF, códigos e datas das fichas e o voucher (data do brinde). Guarda legal (contrato, reserva, documento, lista de espera, ficha VENDEU) impede; nada é apagado nesse caso.
6. Recibo do CRM em `privacy_erasure_receipts` (`done`, `partial`, `failed`, `nothing_to_erase`) e `POST .../erasures/{eventId}/receipt`; recibo não entregue fica pendente e é reenviado. O pedido só é "propagado" quando os 5 sistemas deram recibo (`pendingSystems`).

## Regras de segurança
- `mode: full` e qualquer `keep` diferente de nome/CPF/data do brinde NÃO apagam nada: evento `needs_human`, recibo `failed` com o motivo (decisão em aberto no desenho: segunda confirmação do admin).
- O HMAC é apagado do evento quando termina (`done`/`nothing_to_erase`); fica só se precisa de decisão humana.
- Sem PII em log, evento, recibo ou trilha (testes varrem). 401/429 interrompem a rodada.
- O CRM só anonimiza dado do CRM. Eventos já entregues a outros sistemas não são recolhidos.

## Premissas a confirmar com o GuestPass antes de ligar
Formato da lista (`events`, `nextCursor`), caminho do recibo, e que a chave do feed e o segredo do HMAC são próprios da ponte. O endpoint do GuestPass ainda não existe.

## Fora desta fatia
Receber recibos dos outros sistemas (contrato novo Suite -> CRM -> re-pin; hoje só `recordSystemReceipt` interno), supressão de contato (lista de não contatar) por esta via, tela do admin para `needs_human`, prazo por sistema (decisão do Lucas e do advogado).
