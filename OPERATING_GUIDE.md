# TSE Exclusivo — Guia de Operação

## Propósito

O **TSE Exclusivo** é um sistema proprietário, de empresa única, para conduzir a jornada operacional de timeshare: relacionamento com associados, venda, contrato, utilização, cobrança, financeiro e equipe. A implementação usa apenas referências funcionais e vocabulário de domínio; ela não incorpora código, binários ou dados do produto de referência analisado.

## Sequência operacional recomendada

| Ordem | Área | Ação principal | Resultado esperado |
|---|---|---|---|
| 1 | Clientes | Cadastre o associado, contatos e origem. | Ficha centralizada para atendimento e vendas. |
| 2 | Comercial | Abra uma oportunidade e avance o funil. | Histórico de venda com responsável, valor estimado e follow-up automático em 48 horas quando não houver data definida. |
| 3 | Propostas | Registre referência, produto, entrada, valor e parcelas. | Proposta rastreável, vinculada à oportunidade. |
| 4 | Contratos | Crie o contrato com modelo de uso, valor e primeiro vencimento. | Parcelas calculadas automaticamente sem diferença de centavos. |
| 5 | Documentos | Anexe contrato assinado, aditivo e comprovantes. | Pasta contratual protegida e rastreável. |
| 6 | Reservas | Cadastre empreendimento, unidade e reserva. | Calendário evita conflito de períodos e controla check-in/check-out. |
| 7 | Financeiro | Registre cobrança, baixa de parcela, lançamentos e repasses. | Inadimplência, caixa e compromissos visíveis. |
| 8 | Agenda | Programe follow-ups, vencimentos e atendimentos. | Pendências deixam de depender da memória da equipe. |

## Perfis internos

| Perfil | Escopo de atuação |
|---|---|
| Administração | Acesso integral, inclusive inventário, metas e perfis de equipe. |
| Vendedor | Clientes, oportunidades e acompanhamento comercial. |
| Financeiro | Parcelas, cobranças, baixas, caixa e repasses. |
| Atendimento | Fichas de clientes, interações, tarefas e reservas. |

## Regras que o sistema aplica

O contrato cria o cronograma de parcelas automaticamente. A primeira parcela absorve somente os centavos de ajuste, preservando o valor total contratado. A reserva exige saída posterior à entrada e bloqueia períodos que se sobrepõem para a mesma unidade. Todo cadastro relevante cria trilha de auditoria de criação ou mudança de status.

## Cobrança e boleto

O módulo financeiro registra cobranças de **boleto, PIX, cartão ou transferência**, guardando referência externa, linha digitável e PIX copia-e-cola quando fornecidos. Isso permite operar e auditar a cobrança desde já.

> A emissão bancária automática de um boleto válido depende de integrar a instituição financeira ou gateway escolhido, com credenciais da própria empresa. O sistema não inventa linha digitável nem código PIX; essa é uma trava deliberada de segurança operacional.

## Padronização posterior

Na etapa de operação real, os parâmetros a consolidar são: catálogo de empreendimentos e unidades; numeração de contratos; modelos de uso; políticas de cancelamento; produtos e condições comerciais; origem de leads; banco ou gateway de cobrança; e regras de repasse. A estrutura já está preparada para receber essas definições sem refazer o núcleo do produto.
