# Matriz de Capacidade — TGR-CRM versus Referência TSE

**Base da análise:** ficha real de atendimento enviada, inventário estático do pacote TSExplorer, regras TypeScript enviadas para comissões, cancelamento, borderô, follow-up e mensagens, além do estado validado do TGR-CRM em 20 de agosto de 2026. Esta análise compara **comportamentos de negócio**; nenhum binário, DLL ou código da referência foi reutilizado.

> **Conclusão sem maquiagem:** o TGR-CRM já cobre muito bem o núcleo operacional e, em governança, auditoria, testes e experiência de gestão, está à frente da referência. Mas ele **ainda não faz toda a capacidade do TSE**. Os buracos críticos são comissão por parcela/cancelamento, fração/estoque, recepção em tempo real, assinatura digital, gateway ativo, portal do associado, intercâmbio e captação offline.

## Leitura executiva

| Área | Situação do TGR-CRM | Diagnóstico honesto | Próximo movimento |
|---|---|---|---|
| CRM, associado e relacionamento | Forte | Cadastro 360°, histórico, documentos, radar, onboarding, tarefas e IA com evidência já superam um CRM legado comum. | Consolidar dados reais e regras de contato do time. |
| Captação e qualificação | Forte, com lacuna móvel | A ficha real foi digitalizada com casal, renda, veículo, viagem, brinde, campanha, agenda e tarefa. Falta operar sem sinal e criar ranking próprio de captadores. | Onda 1: offline-first e placar de captação. |
| Recepção e sala de vendas | Parcial | Há agendamento, fila de captação, oportunidade e agenda; ainda faltam mesa, passagem de liner/fechador e cronômetro de tour ao vivo. | Onda 1: painel de recepção em tempo real. |
| Comercial, campanhas e metas | Forte | Funil, proposta, campanha, meta, playbook, desconto governado e ranking de qualidade já existem. | Fechar painel visual de metas na Central de Campanhas. |
| Contratos e documentos | Parcial | Contratos, parcelas, anexos e auditoria existem; assinatura eletrônica nativa ainda não. | Onda 2: Clicksign/DocuSign via adapter e webhook. |
| Financeiro e cobrança | Forte, sem emissão ativa | Parcela, régua, renegociação, DRE e conciliação existem. A memória de gateway foi criada, mas PIX/boleto depende da conta e chave reais. | Onda 2: Asaas conectado, emissão e webhook idempotente. |
| Comissões e borderô | Parcial crítica | O TGR-CRM tem campanhas, lançamentos, aprovação e ranking. Ainda não reproduz a lógica avançada enviada: liberação proporcional por parcela de entrada, calendário de fechamento/dia 7/dia 25, cancelamento e borderô executivo. | **Onda 1: migrar as regras enviadas para domínio testado.** |
| Cancelamento | Parcial crítica | Há renegociação auditável, mas não o ciclo completo de distrato com/sem multa e reversão de comissão futura. | **Onda 1: motor de cancelamento e impacto financeiro/comercial.** |
| Inventário, direito e reserva | Forte, sem fração completa | Unidade, empreendimento, direito de uso, manutenção, disponibilidade, fila, acompanhante e check-in/out estão entregues. Falta estoque explícito de frações/semanas e mapa de ocupação por cota. | Onda 2: frações, semanas e mapa visual. |
| Intercâmbio RCI e utilização | Ausente | A referência cita consulta de utilização e produtos RCI; não há integração equivalente no TGR-CRM. | Onda 3: adapter de intercâmbio, somente após frações. |
| Portal do associado | Ausente | Não existe autosserviço para boleto, semanas, reserva e documentos. | Onda 3: portal permissionado por contrato. |
| Comunicação operacional | Parcial | Interações, tarefas, régua e radar existem; ainda falta canal real de WhatsApp/e-mail/SMS com entrega, resposta e consentimento. | Onda 2: provider direto e trilha de opt-in. |
| Integrações e governança | Forte | Eventos versionados, auditoria, permissões, integração allowlistada, IA permissionada e testes de navegador são superiores ao padrão de sistemas legados. | Manter contrato de integração como porta única. |

## O que já supera a referência

O TGR-CRM já possui características que a referência mapeada não demonstra com a mesma transparência: matriz de permissões central, auditoria append-only, eventos de domínio versionados, reversão protegida de importação, testes de router e navegador, dashboard de exceções, IA com evidência e aprovação humana, além de uma ficha digital de captação que cria associado, oportunidade, campanha e acompanhamento numa única jornada.

No financeiro, a régua de cobrança por estágio, a renegociação com simulação e a DRE de caixa por campanha também criam uma base mais verificável. O ponto, porém, é simples: isso não substitui a lógica específica de comissão/cancelamento que o material enviado revelou.

## O que a referência ainda faz e precisa entrar no TGR-CRM

### Onda 1 — Não negociável para operar melhor que o TSE

| Entrega | Por que vem primeiro | Critério de aceite |
|---|---|---|
| Motor de comissão por parcela e papel | É onde o vendedor confia ou abandona o sistema. | Entrada parcelada libera comissão proporcional; cada papel recebe sua regra; borderô mostra previsto, travado, recebido, cancelado e atrasado. |
| Máquina de cancelamento/distrato | Evita pagar comissão errada e protege caixa. | Fluxo com e sem multa, janela de cancelamento, impacto em parcelas, comissão e auditoria. |
| Recepção ao vivo | Fecha a ponte rua → sala. | Captador agenda, recepção confirma chegada, atribui mesa/liner/fechador e o cronômetro é visível. |
| Captação offline-first | Não se perde lead por sinal ruim. | Ficha fica local, recebe identificador e sincroniza com deduplicação/confirmação ao reconectar. |

### Onda 2 — Receita digital e escala de gestão

| Entrega | Resultado operacional |
|---|---|
| Asaas ativo para PIX/boleto | Parcela gera cobrança com QR/linha digitável; webhook idempotente baixa pagamento e alimenta comissão. |
| Assinatura eletrônica | Proposta/contrato seguem para assinatura com status no TGR-CRM. |
| Comunicação real | WhatsApp/e-mail/SMS com consentimento, rastreio de entrega e resposta. |
| Frações, semanas e mapa | Estoque vende o que existe e mostra a ocupação por cota. |
| Dashboard de campanhas ao vivo | Meta por campanha/equipe/vendedor, desvio e ação recomendada na tela de gestão. |

### Onda 3 — Vantagem estrutural sobre a referência

| Entrega | Diferencial |
|---|---|
| Portal do associado | Segunda via, pagamentos, reservas, uso, documentos e solicitações sem atendimento manual. |
| Intercâmbio | Camada adapter para RCI/parceiros, isolada do domínio interno. |
| Gamificação de captação | Ranking, metas, prêmio, conversão e qualidade — não só volume. |
| Inteligência operacional avançada | IA com dados limpos para priorizar recuperação, risco de cancelamento e próxima melhor ação. |

## Regras de implementação

O TGR-CRM continuará proprietário e de empresa única. A referência serve para entender a operação, não para copiar código, binário, banco, marca ou dados. Toda evolução deverá preservar o modelo já validado: regra pura testável, router protegido, migração revisada, evento/auditoria e tela com estado real.

## Veredito

Hoje o TGR-CRM é um **CRM/ERP operacional de timeshare forte**, com uma fundação de governança superior à referência. Ele está pronto para cadastrar, captar, vender, contratar, cobrar, reservar, gerir campanha e operar atendimento. Para afirmar que faz **tudo** que o TSE faz — e melhor — ainda faltam as quatro entregas de Onda 1 e, depois, gateway/assinatura/frações/portal/intercâmbio.

O caminho não é recomeçar. É pegar a máquina já pronta e encaixar as regras de rua e de dinheiro que você acabou de entregar.

## Evidências analisadas

| Evidência | Uso na matriz |
|---|---|
| `photo_2026-08-20_16-43-03.jpg` | Estrutura real da ficha de atendimento e critérios de qualificação. |
| `TSExplorer.zip` e inventário técnico estático | Módulos, entidades e nomenclaturas funcionais da referência. |
| `engenharia_reversa.md` | Mapeamento anterior de app, desktop, entidades e fluxo da referência. |
| `lib-comissoes.ts`, `lib-cancelamento.ts`, `lib-bordero.ts`, `lib-datasComissao.ts`, `lib-followups.ts`, `lib-mensagens.ts` | Regras operacionais sofisticadas que devem ser portadas como domínio proprietário. |
| Código, schema e testes do TGR-CRM | Capacidades efetivamente implementadas e validadas no produto. |
