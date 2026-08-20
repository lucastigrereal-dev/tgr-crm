# Contrato de Integração de Eventos — v1

## Escopo

O TSE Exclusivo oferece uma leitura autenticada do catálogo e do feed de eventos de domínio pelo tRPC: `integrations.contract` e `integrations.eventFeed`. O contrato atual é **`tse.events.v1`** e só pode ser consultado por administradores autenticados.

| Elemento | Regra v1 |
|---|---|
| Fonte de verdade | Tabela append-only de eventos de domínio |
| Envelope | Versão, identificador do evento, nome, agregado, ator, data e payload allowlistado |
| Consulta | Até 100 eventos, com filtro opcional por nome catalogado |
| Privacidade | O payload remove campos fora da allowlist específica de cada evento |
| Extensão | Novo evento exige entrada no catálogo, allowlist, teste e incremento de contrato se quebrar consumidores |

## Consumidores previstos

Integrações futuras de gateway de cobrança, mensageria, BI e assistentes de IA devem consumir o envelope v1; elas não escrevem diretamente no banco transacional. Webhooks outbound só serão habilitados com um conector autenticado, escopo explícito, assinatura de entrega, retentativa e trilha de auditoria.

> Não há credenciais nem endpoints externos configurados por padrão. Isso evita transformar um ‘campo de integração’ em porta aberta de vazamento.
