# Auditoria TSE e Benchmark de Multipropriedade — Em Andamento

## Limite de segurança e propriedade intelectual

O acervo enviado contém pacotes binários, DLLs, instalador, arquivos de configuração, logs e materiais que podem conter dados pessoais e financeiros. A análise é **clean-room**: o TGR-CRM aproveitará somente requisitos funcionais, modelos de operação e controles identificados de forma lícita. Não serão executados binários, copiados códigos, importados dados pessoais, segredos, logs ou arquivos de configuração do TSE.

## Achados iniciais do acervo

O inventário passivo do `TSExplorer.zip` confirma uma referência madura em contratos/parcelas, contatos de cobrança, histórico e solicitações de cancelamento, relatórios financeiros, grids, pivôs, dashboards, impressão, planilhas e integração de cobrança. A presença de telas preservadas de acompanhamento de vendas, contrato financeiro, contatos de cobrança, histórico e solicitações de cancelamento reforça que a apresentação do TGR deve comprovar a jornada ponta a ponta, e não só a venda inicial.

O pacote também inclui logs, dados de cliente, binários de meios de pagamento e componentes de terceiros. Esses itens foram classificados como **proibidos para importação, execução e reutilização**.

### Cobertura funcional confirmada pela documentação AS-IS

O material catalogado aponta 16 blocos funcionais e confirma que a referência não era só CRM comercial: incluía captação, sala de vendas, contratos, parcelas, cobrança, utilização/pontos, reservas/intercâmbio, estoque de cotas, comissões, retenção, integrações, relatórios e administração. Em particular, as telas observadas indicam filtros combinados de venda por data, unidade, equipe e status; histórico financeiro de parcelas; contatos de cobrança; e cancelamento com motivo, responsáveis e contenção.

O TGR já cobre o coração desses fluxos, mas a auditoria abriu quatro lacunas que entrarão no diagnóstico: **pontos/intercâmbio**, **integrações PMS/ERP e assinatura**, **observabilidade operacional de integrações/filas** e **torre de comando com recortes financeiros e de carteira mais profundos**. A referência também confirma uma fronteira: parâmetros financeiros exatos, comissão, hierarquia comercial, permissões e cláusulas por empreendimento nunca devem ser presumidos; precisam ser dados configuráveis e aprovados pela operação.

> A oportunidade não é reproduzir os 759 formulários legados; é condensar as capacidades que importam em jornadas simples, auditáveis e filtráveis.

## Achados iniciais de benchmark público

A WAM comunicou uma jornada digital de compra que inclui seleção, assinatura digital e campanhas de marketing, coexistindo com salas de vendas físicas.[1] A GAV se apresenta publicamente como operação verticalizada, da captação de terreno à venda de cotas, construção e gestão, destacando hotelaria como parte da experiência do proprietário.[2] A Your Vacation descreve a integração entre geração de demanda, gestão de leads, vendas digitais, telesales, mini-vac e time comercial, com foco em CAC e qualidade de venda.[3] Um painel setorial destacou a necessidade de observar vendas de alto impacto, múltiplos canais, sustentabilidade de caixa, cancelamentos e pós-venda.[4]

## Hipóteses de requisitos para validar no próximo ciclo

1. Torre de comando com filtros transversais de empreendimento, campanha, canal, sala, time, promotor, liner, fechador, período, coorte e carteira.
2. Funil ponta a ponta desde origem do lead, convite, chegada, tour, proposta, contrato, entrada, recebimento, cancelamento, reserva e relacionamento do proprietário.
3. Métricas de eficiência por canal: CAC, custo por comparecimento, custo por tour, custo por venda, VGV, entrada recebida, inadimplência, distrato e comissão.
4. Gestão de carteira e customer success por coorte, uso de reserva, engajamento, cobrança, risco de cancelamento e oportunidade de recompra/indicação.

## Princípios iniciais da torre de comando

As referências internacionais de gestão de vacation ownership reforçam que o sistema central precisa compartilhar dados entre reservas, direitos de uso, proprietário, cobrança, contratos, manutenção e operação; portal do proprietário, comunicação automatizada e relatórios agendados deixam de ser luxo quando a carteira cresce.[5] [6] A camada gerencial não deve ser uma tela única lotada: precisa de painéis por papel, atualizados no ritmo da decisão, combinando **indicadores de entrada** (resposta ao lead, comparecimento, tours, follow-ups, custo) e **indicadores de saída** (VGV, entrada recebida, conversão, carteira, inadimplência, distrato e margem).[7]

Para o TGR, a proposta inicial é uma torre em cinco painéis conectados por filtros globais: **Geral executivo**, **Guerra comercial**, **Sala e captação**, **Carteira/financeiro** e **Operação/proprietário**. Cada número deve revelar o detalhe que o explica — uma exceção de cobrança abre as parcelas/contatos; uma queda de conversão abre a campanha, equipe, sala e captação; uma anomalia de reserva abre inventário, direito e manutenção. Sem caça ao tesouro em planilha.

## Requisitos técnicos e de governança encontrados no blueprint

O blueprint reforça padrões que o TGR deve completar antes de crescer integração externa: idempotência para escritas sensíveis, paginação por cursor nos grids volumosos, controle otimista de estoque/parcela/contrato, webhooks com assinatura e janela anti-replay, dinheiro com precisão decimal e nenhum dado de cartão em log. Integrações com PMS, ERP, assinatura e pagamentos devem ter health check, envio idempotente, recepção idempotente, reconciliação, timeout, retentativa, circuito de proteção e fila de erro.[8]

Os documentos também destacam duas frentes ainda pendentes no TGR: **captação offline-first** — banco local, fila de comandos e resolução de conflito — e **ledger financeiro imutável**, no qual correções, baixas, estornos, renegociações e chargebacks geram lançamentos, nunca mutações silenciosas. Para a operação de uma empresa única, o requisito de multiempresa não se aplica; segregação por empreendimento, papel e escopo operacional permanece obrigatória.

As referências de migração e RBAC fortalecem a necessidade de filtros governados: cada consulta e exportação precisa respeitar perfil, empreendimento, carteira e finalidade. O painel de integração deverá medir eventos processados, duplicados, falhos, reprocessados, reconciliados e envelhecidos; o painel de dados deverá medir completude, duplicidade, inconsistência e campos críticos sem responsável.

## Referências

[1]: https://revistahoteis.com.br/wam-lanca-plataforma-100-online-de-venda-de-multipropriedade-imobiliaria/ "WAM lança plataforma 100% online de venda de multipropriedade imobiliária"
[2]: https://hoteliernews.com.br/gav-quer-mais-hospitalidade-sem-abrir-mao-do-dna-da-multipropriedade/ "GAV quer mais hospitalidade sem abrir mão do DNA da multipropriedade"
[3]: https://turismocompartilhado.com.br/your-vacation-avanca-em-expansao-comercial-e-fortalece-operacao-digital/ "Your Vacation avança em expansão comercial e fortalece operação digital"
[4]: https://turismocompartilhado.com.br/executivos-apontam-evolucoes-no-modelo-de-vendas-da-multipropriedade/ "Executivos apontam evoluções no modelo de vendas da multipropriedade"
[5]: https://resortdata.com/timeshare-fractionals/ "Timeshare Management Software for Every Ownership Model"
[6]: https://www.viewpointweb.com/ "Viewpoint Timeshare Management"
[7]: https://www.geckoboard.com/dashboard-examples/sales/ "Sales dashboards: examples, KPIs, and how to build one"
[8]: Material documental do pacote TSExplorer enviado pelo usuário: padrões de API, matriz de integrações, contrato de adapter, ADRs e SLOs. Análise passiva em 20 de agosto de 2026.
