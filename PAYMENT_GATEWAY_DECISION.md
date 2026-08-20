# Cobrança Digital — Decisão de Integração

## Princípio

O TGR-CRM não emite boleto ou PIX fictício. A camada de cobrança só solicita emissão após uma conta de gateway estar conectada e as credenciais serem fornecidas de forma segura.

## Decisão de arquitetura

Será criado um adaptador de gateway com contrato próprio, para que contratos e parcelas não dependam de um fornecedor específico. A primeira implementação operacional será orientada ao **Asaas**, pois sua API pública documenta cobrança com `billingType: PIX`, QR Code dinâmico e payload copia-e-cola. O contrato preserva a possibilidade de incluir Stripe ou Mercado Pago posteriormente, sem migrar os dados do CRM.

## Observações de elegibilidade

O Stripe documenta suporte a Boleto para contas brasileiras e PIX para contas brasileiras mediante habilitação, que pode estar sujeita a convite. Por isso, não será tratado como disponibilidade garantida antes da ativação na conta do negócio.

## Contrato operacional do Asaas

O adaptador deverá criar ou reaproveitar o cliente externo usando `POST /v3/customers`, persistindo o identificador retornado e usando `externalReference` do TGR-CRM para prevenir duplicidade. Cada parcela gera uma cobrança única via `POST /v3/payments`, com `billingType` igual a `PIX` ou `BOLETO`, valor, vencimento e referência externa da parcela.

Para boleto, o CRM persistirá o ID remoto, `invoiceUrl`, `bankSlipUrl`, status e a linha digitável obtida em `GET /v3/payments/{id}/identificationField`. Para PIX, persistirá o ID remoto, a URL de fatura, o código copia-e-cola e a imagem do QR Code retornados pelo endpoint de QR Code da cobrança.

O endpoint de webhook aceitará somente o header `asaas-access-token` correspondente ao segredo configurado. O ID de evento será registrado para idempotência: eventos repetidos não podem baixar parcela duas vezes. `PAYMENT_RECEIVED` e `PAYMENT_CONFIRMED` atualizam a cobrança e a parcela dentro de transação auditável; `PAYMENT_OVERDUE` apenas atualiza o estado, sem criar baixa financeira.

| Forma | Resultado esperado no CRM | Confirmação de pagamento |
|---|---|---|
| PIX | QR Code dinâmico, imagem e código copia-e-cola | Webhook do gateway atualiza a parcela auditadamente |
| Boleto | URL/PDF ou linha digitável e vencimento | Webhook do gateway atualiza a parcela auditadamente |

## Fontes

1. [Asaas — Cobranças via Pix / QR Code dinâmico](https://docs.asaas.com/docs/cobrancas-via-pix)
2. [Stripe — Pix payments](https://docs.stripe.com/payments/pix)
3. [Stripe — Boleto payments](https://docs.stripe.com/payments/boleto)
4. [Asaas — Cobranças via boleto](https://docs.asaas.com/docs/cobrancas-via-boleto)
5. [Asaas — Introdução a Webhooks](https://docs.asaas.com/docs/sobre-os-webhooks)
6. [Asaas — Criar nova cobrança](https://docs.asaas.com/reference/criar-nova-cobranca)
7. [Asaas — Criar novo cliente](https://docs.asaas.com/reference/criar-novo-cliente)
