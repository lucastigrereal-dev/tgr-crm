# Alertas de integridade comercial — matriz de implantação

## Princípio

> Um alerta do TGR precisa apontar **fato, evidência, responsável e ação**. Ausência de dado não é fraude; é fronteira de instrumentação.

| Alerta | Situação | Fonte atual | Regra já segura | Dono |
| --- | --- | --- | --- | --- |
| Comissão sem lastro | **Ativo na Torre** | Comissão + parcela-fonte | Comissão pendente/aprovada vinculada a parcela não paga, cancelada, vencida ou renegociada | Financeiro |
| Follow-up vencido | **Ativo na Torre** | Oportunidade | Sem próximo passo ou prazo estourado | Comercial |
| Captação sem desfecho | **Ativo na Torre** | Ficha de captação | Ficha parada após 24 horas em estado captado | Recepção / comercial |
| Distrato sem decisão | **Ativo na Torre** | Solicitação de distrato | Pedido em estado `requested` | Administração / financeiro |
| Desconto irregular | **Ativo na Torre para pedidos pendentes** | Pedido de aprovação de desconto | Pedido pendente com percentual registrado; aprovação válida encerra a exceção | Gerência comercial |
| Documento contratual pendente | **Ativo na Torre** | Documento de contrato + política do empreendimento | Contrato ativo sem categoria declarada na política vigente | Contratos |
| Duplicidade provável | **Ativo para coincidência exata** | Associado | CPF/CNPJ ou telefone normalizado idêntico; matching fuzzy continua fora do disparo | RevOps |
| Distorção de mesa / reabertura | **Ativo para reabertura registrada** | Eventos de oportunidade | Evento `opportunity.updated` com estágio anterior terminal e novo estágio diferente; distorção estatística de mesa continua preparada | Gestão de sala |

## Próximo corte seguro

A Torre já lê a política vigente do empreendimento, compara com os documentos anexados e abre exceção para contratos ativos sem a categoria requerida. Os sinais de desconto, duplicidade exata e reabertura registrada também possuem fontes conectadas; matching fuzzy, distorção estatística de mesa e desconto efetivamente aplicado fora da trilha ainda exigem instrumentação adicional. Sem política de empreendimento, o TGR não assume que “um documento” serve para todo contrato.
