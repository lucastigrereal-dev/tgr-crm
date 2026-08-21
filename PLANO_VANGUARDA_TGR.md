# TGR-CRM — Auditoria Clean-Room, Benchmark e Plano de Vanguarda

> **Tese:** o TGR não deve ser uma cópia do TSE nem outro CRM que morre na assinatura. Deve ser a **espinha dorsal única** da operação: captar, vender, contratar, receber, cuidar do proprietário, entregar uso e mostrar exceções antes que virem rombo.

## 1. Auditoria do acervo TSE: veredito honesto

O acervo fornecido foi auditado de forma **passiva e clean-room**. O pacote contém 1.388 arquivos, 24 assemblies, 759 formulários, 1.342 entidades/DTOs, 108 jobs e 20 integrações mapeadas. Ele comprova amplitude funcional em captação, sala, contratos, parcelas, cobrança, utilização, estoque, comissões, retenção, integrações e BI. Também contém binários, logs, dados pessoais e configurações que **não serão executados, copiados ou importados**.

| Bloco comprovado no acervo | Estado do TGR hoje | Decisão |
|---|---|---|
| Captação, casal, qualificação e sala | Forte; ficha, recepção, mesa, liner, fechador e tour | Consolidar SLAs, passagem de bastão e capacidade da sala |
| Comercial, proposta, contrato e parcelas | Forte | Fechar assinatura, checklist e qualidade de contrato |
| Cobrança, baixa, régua e conciliação | Forte | Adicionar priorização por risco, promessas e integrações reais quando liberadas |
| Comissão e borderô | Em consolidação | Fechar prova isolada de baixa e ciclo de estorno/distrato |
| Retenção e distrato | Em consolidação | Executar aprovação transacional e ações de contenção |
| Reservas e inventário | Forte para reserva/unidade | Evoluir direitos de uso, pontos, intercâmbio e portal |
| Integrações, jobs e observabilidade | Fundação existente | Criar outbox/inbox, saúde, reconciliação e reprocessamento |
| Relatórios/BI | Painel e exports existentes | Construir torre de comando por papel e catálogo de métricas |

### Limites que não serão chutados

Regras de multa, devolução, comissão, hierarquia, cláusulas e pagamentos variam por empreendimento. Portanto, entram como **configuração versionada por projeto e aprovação humana**, não como porcentagem tatuada no código.

## 2. Benchmark: o que o mercado ensina

Operações públicas de multipropriedade brasileiras enfatizam venda híbrida/digital, cadeia comercial e pós-venda. Plataformas internacionais de vacation ownership reforçam uma verdade menos glamourosa e mais importante: reservas, direitos de uso, carteira, cobrança, manutenção, proprietário e gestão precisam compartilhar o mesmo registro operacional.[1][2][3][4]

| Padrão de mercado | Requisito TGR |
|---|---|
| Vendas digitais coexistem com sala física | Jornada única de origem até assinatura/entrada, com atribuição de canal |
| Operação verticalizada | Empreendimento como contexto de regras, produto, equipe, caixa e carteira |
| Proprietário exige autosserviço | Portal futuro para contrato, parcela, documento, reserva, uso e chamados |
| Proprietário não é hóspede comum | Direitos, saldo, período, cobrança e relacionamento na mesma ficha 360° |
| Gestão precisa agir no mesmo dia | Painéis por papel, atualização operacional, alertas e drill-down |

## 3. Torre de comando: cinco dashboards que prestam

Não existe “o dashboard mais completo do mundo” numa página só — isso vira painel de avião para quem está vendendo água de coco. O certo é uma **torre conectada**: mesmo filtro global, visão por papel e cada número abre a lista que o explica.

| Painel | Pergunta que responde | KPIs de ação |
|---|---|---|
| Geral executivo | Onde caixa, venda, carteira e operação desviaram? | VGV, entrada recebida, margem, carteira vencida, distrato, ocupação, exceções críticas |
| Guerra comercial | Qual canal/time/sala está vazando conversão? | CAC, comparecimento, tour, proposta, contrato, ticket, tempo de resposta, meta versus ritmo |
| Sala e captação | Onde a experiência presencial está morrendo? | espera, no-tour, tour, mesa/hora, passagem de bastão, conversão por promotor/liner/fechador |
| Carteira e financeiro | O vendido virou caixa saudável? | entrada prevista/recebida, aging, promessas, recuperação, renegociação, comissão, distrato por coorte |
| Operação e proprietário | O cliente recebeu valor depois da venda? | onboarding, primeira reserva, uso, chamados, manutenção, disponibilidade, satisfação e risco |

### Filtros globais obrigatórios

Período, empreendimento, unidade/cota, campanha, canal, origem, sala, turno, equipe, promotor, liner, fechador/FTB, vendedor, produto, status, coorte de venda, faixa de VGV, faixa de entrada, aging, risco, motivo de perda/cancelamento, carteira e responsável. Todo filtro deve respeitar permissão e abrir drill-down seguro.

## 4. As 50 evoluções priorizadas

### Agora — fecha a operação e a apresentação

| # | Evolução | Resultado concreto |
|---:|---|---|
| 1 | Máquina única de estados lead→proprietário | Nenhum negócio sem etapa, dono, próximo passo e SLA |
| 2 | Distribuição de leads por capacidade e SLA | Lead não apodrece sem dono |
| 3 | Scorecard de sala por turno/mesa/equipe | Descobre gargalo real, não culpa aleatória |
| 4 | Passagem de bastão auditada promotor→liner→fechador | Contexto não se perde na sala |
| 5 | Checklist de proposta e contrato | Menos retrabalho e contestação |
| 6 | Esteira de assinatura digital provider-agnostic | Venda vira contrato válido mais rápido |
| 7 | Qualidade de cadastro e deduplicação | CPF, telefone e e-mail deixam de virar cemitério de duplicata |
| 8 | Fila de cobrança por risco e promessa | Cobrança vira prioridade, não lista cega |
| 9 | Contatos de cobrança e retenção omnicanal | Histórico único de cada tentativa |
| 10 | Execução transacional aprovada de distrato | Contrato, parcelas e comissão revertem com trilha |
| 11 | Ações de contenção e reversão | Mede valor preservado, motivo e responsável |
| 12 | Prova E2E isolada de baixa→comissão | Dinheiro não depende de fé no mock |
| 13 | Torre executiva com exceções | Diretoria enxerga problema antes da reunião virar velório |
| 14 | Torre guerra comercial | Meta, ritmo, cobertura e vazamento por origem/time |
| 15 | Torre sala/captação | Espera, no-tour, conversão e produtividade ao vivo |
| 16 | Torre carteira/financeiro | VGV separado de entrada, aging e distrato |
| 17 | Catálogo de métricas e definições | Um KPI para de ter cinco versões em planilhas |
| 18 | Drill-down em todo indicador | Número abre contrato, captura, parcela ou reserva |
| 19 | Metas em cascata | Meta mensal vira leads, tours, propostas e entrada diária |
| 20 | Scorecard equilibrado de pessoas | Produção com qualidade, recebimento e retenção |

### Próxima onda — transforma CRM em sistema de empresa

| # | Evolução | Resultado concreto |
|---:|---|---|
| 21 | Direitos de uso por contrato/cota | O que foi vendido pode ser entregue sem conflito |
| 22 | Pontos, créditos, débitos e validade | Saldo e expiração deixam de ser conversa de telefone |
| 23 | Intercâmbio e regras de elegibilidade | Uso externo controlado e rastreável |
| 24 | Reserva com pré-validação de direito, caixa e manutenção | Menos overbooking e exceção clandestina |
| 25 | Portal do proprietário | Contrato, boleto, documento, reserva e chamado em autosserviço |
| 26 | Onboarding 7/30/90/180 dias | Reduz arrependimento e distrato precoce |
| 27 | Saúde da carteira por coorte | Enxerga ativação, uso, atraso e risco por origem/venda |
| 28 | Indicação, recompra e upgrade | Proprietário vira canal de crescimento, não só boleto |
| 29 | Inventário comercial com reserva e expiração | Não vende unidade/cota indisponível |
| 30 | Integração PMS com reconciliação | Reserva e inventário não ficam divergentes |
| 31 | Integração ERP/contábil por adapter | Financeiro sem exportação de madrugada |
| 32 | Assinatura, pagamento e webhooks idempotentes | Evento repetido não duplica dinheiro nem contrato |
| 33 | Central de saúde de integrações | Fila, erro, tentativa, latência e reprocessamento seguro |
| 34 | Outbox/inbox transacional | Integração resiliente sem gambiarra assíncrona |
| 35 | Ledger financeiro derivado e imutável | Baixa, estorno e renegociação explicáveis no tempo |
| 36 | Relatórios agendados por perfil | Reunião começa com dado certo sem caça à planilha |
| 37 | Exportação governada e mascaramento | Controle de PII e evidência de quem exportou |
| 38 | Captação offline-first | Promotor não perde ficha porque o Wi-Fi virou pó |
| 39 | Grade de capacidade de sala | Campanha não lota operação além de mesa/equipe disponível |
| 40 | Auditoria de qualidade de venda | Coaching baseado em evidência, não grito |

### Vanguarda — vantagem que o concorrente sente tarde

| # | Evolução | Resultado concreto |
|---:|---|---|
| 41 | Score explicável de comparecimento | Prioriza confirmação sem discriminação ou caixa-preta |
| 42 | Score explicável de risco de distrato | Retenção age antes do pedido formal |
| 43 | Score explicável de inadimplência | Cobrança escolhe fila com chance real de recuperação |
| 44 | Próxima melhor ação por papel | Sistema recomenda tarefa com motivo, prazo e evidência |
| 45 | Previsão de meta em cenários | Conservador, provável e agressivo antes do mês morrer |
| 46 | Gêmeo operacional de caixa/capacidade | Simula venda, recebimento, ocupação, manutenção e distrato |
| 47 | Laboratório de campanhas e atribuição madura | CAC medido até entrada recebida e retenção, não só lead |
| 48 | Orquestrador omnicanal consentido | Jornadas por evento com opt-out, limite e experimento |
| 49 | Qualidade e observabilidade de dados | Campos críticos, duplicatas, fila velha e divergência viram alerta |
| 50 | Centro de comando de exceções | Uma fila única de risco comercial, financeiro, operacional e integração |

## 5. Ordem de ataque recomendada

1. **Não negociar:** torre de comando, filtros globais, drill-down, funil único, qualidade de contrato e prova real de baixa/comissão.
2. Fechar distrato com aprovação/execução auditável e retenção mensurável.
3. Direitos de uso, pontos, elegibilidade de reserva, portal e onboarding de proprietário.
4. Integrações resilientes com gateway, assinatura, PMS e ERP — código direto, adapters e reconciliação; nada de gambiarra por Make/n8n.
5. Scores e IA somente após dados completos, consentidos, versionados e com evidência visível.

## Fontes públicas

[1]: https://revistahoteis.com.br/wam-lanca-plataforma-100-online-de-venda-de-multipropriedade-imobiliaria/ "WAM e venda digital de multipropriedade"
[2]: https://hoteliernews.com.br/gav-quer-mais-hospitalidade-sem-abrir-mao-do-dna-da-multipropriedade/ "GAV e operação verticalizada"
[3]: https://turismocompartilhado.com.br/your-vacation-avanca-em-expansao-comercial-e-fortalece-operacao-digital/ "Your Vacation e operação comercial digital"
[4]: https://resortdata.com/timeshare-fractionals/ "RDP Timeshare & Fractionals"
[5]: https://www.viewpointweb.com/ "Viewpoint Timeshare Management"
[6]: https://easymerlin.com/articles/what-timeshare-management-software-should-do/ "What Timeshare Management Software Should Do"
[7]: https://www.geckoboard.com/dashboard-examples/sales/ "Sales dashboards: examples, KPIs, and how to build one"

## Nota de integridade

As capacidades TSE foram extraídas por análise passiva da documentação fornecida e tratadas como **referência funcional**, não como código ou propriedade a copiar. Regras comerciais, financeiras e jurídicas específicas seguem dependentes de validação operacional por empreendimento.
