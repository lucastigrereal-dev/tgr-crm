# Alertas de integridade comercial — matriz de implantação

## Princípio

> Um alerta do TGR precisa apontar **fato, evidência, responsável e ação**. Ausência de dado não é fraude; é fronteira de instrumentação.

| Alerta | Situação | Fonte atual | Regra já segura | Dono |
| --- | --- | --- | --- | --- |
| Comissão sem lastro | **Ativo na Torre** | Comissão + parcela-fonte | Comissão pendente/aprovada vinculada a parcela não paga, cancelada, vencida ou renegociada | Financeiro |
| Follow-up vencido | **Ativo na Torre** | Oportunidade | Sem próximo passo ou prazo estourado | Comercial |
| Captação sem desfecho | **Ativo na Torre** | Ficha de captação | Ficha parada após 24 horas em estado captado | Recepção / comercial |
| Distrato sem decisão | **Ativo na Torre** | Solicitação de distrato | Pedido em estado `requested` | Administração / financeiro |
| Desconto irregular | Preparado, não disparado | Aprovação de desconto | Falta campo que liga desconto efetivamente aplicado à proposta/contrato e sua alçada por versão | Gerência comercial |
| Documento contratual pendente | Preparado, não disparado | Documento de contrato | Falta política versionada que define categorias obrigatórias por empreendimento e estágio | Contratos |
| Duplicidade provável | Preparado, não disparado | Associado / captação | Falta decisão operacional sobre chaves e janela de similaridade; nunca haverá merge automático | RevOps |
| Distorção de mesa / reabertura | Preparado, não disparado | Captação / eventos | Falta contagem persistida de reabertura e regra formal de exceção por sala | Gestão de sala |

## Próximo corte seguro

O próximo incremento de alerta deve ser **documentação contratual pendente**, mas somente depois de a versão da política de empreendimento declarar as categorias exigidas. A implementação lê essa política vigente, compara com documentos anexados e abre exceção para contratos ativos sem a categoria requerida. Sem essa política, o TGR não assume que “um documento” serve para todo empreendimento.
