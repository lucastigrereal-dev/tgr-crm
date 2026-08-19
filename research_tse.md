# Pesquisa de Referência — TSE CRM Exclusivo

## Limite de reutilização

O repositório `lucastigrereal-dev/tgsolutions` foi usado como **referência funcional, de arquitetura e de experiência**. O sistema será uma reimplementação proprietária e independente, sem incorporar binários, código decompilado, dados operacionais ou identidade visual do sistema de terceiros.

## Evidências públicas relevantes

| Fonte | Evidência observada | Impacto no CRM exclusivo |
|---|---|---|
| Time Share Soluções | Descreve marketing, abordagem, recepção/tours, propostas e vendas, contratos, financeiro, disponibilidade, utilização, contatos, pós-venda, comissões, documentos e integrações como capacidades da solução TSExplorer. | Confirma os módulos centrais do produto e orienta a prioridade de implementação interna. |
| Niara | Descreve integração entre TSExplorer, disponibilidade on-line, reservas com diárias ou pontos e pagamentos por cartão ou Pix. | Mantém a arquitetura preparada para integrações de reserva e cobrança, mas deixa conectores externos fora do primeiro núcleo funcional. |
| SS&C TimeShareWare | Apresenta vendas, contratos, gestão de proprietários, reservas, inventário/disponibilidade e administração de operação como composição típica de uma solução de timeshare. | Valida a proposta de um núcleo único para comercial, contratos, atendimento, reservas e operação. |
| ADIT Brasil | Diferencia timeshare como direito de uso e multipropriedade como propriedade fracionada; ambos demandam controle de períodos de ocupação e relacionamento contínuo com cliente. | Sustenta a separação explícita entre contrato, direito de uso, unidade/período e reserva no modelo de dados. |

## Decisões de produto

O produto será **de empresa única**. O blueprint anterior continha `tenant_id` e separação multiempresa; estes elementos não serão levados para o banco novo. Permanecem, contudo, a auditoria por usuário, a trilha financeira e o controle de permissões, porque isso evita a famosa operação “ninguém sabe quem clicou e agora fodeu”.

O núcleo inicial será organizado em oito domínios: clientes, contratos, vendas, unidades e reservas, financeiro, agenda e tarefas, usuários e painel operacional. A primeira entrega deve privilegiar fluxos completos e rastreáveis, em vez de tentar recriar as centenas de telas do legado.

## Referências

[1] [Time Share Soluções — Sistema TSExplorer](https://timesharesolucoes.com.br/)

[2] [Niara — Integração para gestão de timeshare e propriedades fracionadas](https://niara.tech/novidade-integracao-para-gestao-de-timeshare-e-propriedades-fracionadas/)

[3] [SS&C — TimeShareWare](https://www.ssctech.com/solutions/timeshareware)

[4] [ADIT Brasil — Multipropriedade, Timeshare e Fractional](https://adit.com.br/a-historia-por-tras-da-multipropriedade-do-timeshare-e-do-fractional/)
