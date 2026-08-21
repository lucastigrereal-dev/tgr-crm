# Limites de validação operacional

## Comprovado nesta base

O projeto executa checagem de tipos e **71 testes automatizados** de regras de domínio, permissões, CSV, funil, comissão, autenticação, reversão controlada, exportação, inventário, lista de espera, acompanhantes, segurança, integração, analytics e IA permissionada. O backend valida formato de importação, relatórios de erro, filtros comerciais, conversão da fila em reserva e check-in/check-out de acompanhantes sem depender do navegador.

A reversão foi exercitada com uma infraestrutura de banco controlada: associados criados são removidos, associados atualizados recuperam o snapshot anterior, contratos importados são removidos junto das parcelas quando não há dependências, e documentos, reservas, tarefas, cobranças, lançamentos financeiros ou contratos dependentes bloqueiam a exclusão. A exportação filtrada possui contrato determinístico para etapa, dados da proposta, data e nome do arquivo, além de testes que comprovam a entrega dessas linhas aos escritores XLSX e PDF.

## Deliberadamente não executado no banco ativo

A reversão de um lote CSV altera associados, contratos e parcelas. A execução de uma carga artificial, seguida de reversão, não será feita no banco operacional compartilhado. A mesma cautela vale para uma sessão autenticada de navegador disparar downloads em massa.

## Condição para E2E completo

O projeto possui Playwright configurado com uma sessão de proprietário legítima e efêmera, criada pelo próprio SDK e nunca gravada no repositório. **Nove testes autenticados de navegador** confirmam: Central de Reservas, vínculo contratual na fila, central de relacionamento, copiloto de IA, drill-down do dashboard, navegação por teclado, download real de XLSX/PDF filtrado, confirmação visual de reversão CSV e a jornada de oferta para reserva com presença de acompanhante.

As respostas tRPC dos E2Es regulares de reversão, download e reserva são controladas no navegador, para comprovar interface e arquivo sem semear registros artificiais. Além disso, **três E2Es estritos** foram executados contra backend e MySQL descartável isolados: importação/reversão de CSV, download real de XLSX/PDF e jornada waiting → offered → reserva → check-in → acompanhante → check-out. O laboratório foi limpo ao final da validação.

## Distrato: domínio comprovado, evidência visual pendente

Em 21 de agosto de 2026, a suíte passou a ter **125 testes automatizados**. O domínio de distrato cobre execução única de uma solicitação aprovada, bloqueio de pedido não aprovado ou já executado, preservação de parcelas e comissões pagas, cancelamento dos itens reversíveis e propagação de falha intermediária sem registrar auditoria de sucesso. A execução também grava os impactos financeiros previstos abaixo, dentro da transação auditável.

| Impacto | Lançamento previsto | Evidência automatizada |
| --- | --- | --- |
| Multa ou retenção | Receita em `Distrato · multa/retenção` | `server/contracts.events.test.ts` |
| Reembolso | Despesa em `Distrato · reembolso` | `server/contracts.events.test.ts` |

As rotas autenticadas `/contratos` e `/contratos/1` foram inspecionadas no ambiente de desenvolvimento em 21 de agosto de 2026. A lista exibiu **Pasta contratual vazia** e a ficha retornou **Contrato não encontrado**; não há contrato real neste ambiente para acionar os controles visuais de solicitação, aprovação, rejeição e execução. A prova visual do ciclo humano continua pendente para uma homologação isolada com contrato descartável, parcelas abertas e pagas e comissões em estados distintos. Não serão criados dados operacionais artificiais apenas para fabricar captura de tela.

## Recepção: fronteira da jornada completa

As regras de transição, os procedimentos de roteador e a fila com atualização por polling de cinco segundos estão cobertos. Ainda falta executar, contra banco isolado ou E2E real com dados descartáveis, a jornada integral `fila → chegada/mesa/equipe → início → fim` e o ramo `fila → sem-tour`, verificando a persistência e a saída dos estados encerrados da fila ativa.

## Tempo real estrito e gateway de cobrança

O painel de sala atualmente consulta a fila a cada cinco segundos. Essa solução é deliberadamente segura e suficiente para a operação assistida, porém **não deve ser chamada de tempo real estrito**. SSE ou WebSocket exigem processo persistente em produção; no modo de hospedagem contínua do projeto, isso usa uma instância única de 1 vCPU e 512 MB, com custo de computação de até US$ 37,50/mês em utilização integral, descontado o crédito mensal de US$ 10 e acrescido somente de tráfego/armazenamento efetivamente usado. A mudança só deve ser habilitada com aceite explícito do responsável pela operação e publicação em hospedagem contínua.

A emissão real de boleto e PIX permanece intencionalmente inativa até o cadastro seguro das credenciais do gateway Asaas e a definição de ambiente, chaves, política de webhook, idempotência e reconciliação. As tabelas de clientes e eventos de webhook já existem para suportar a integração, mas o TGR-CRM não cria boleto, QR Code ou cobrança falsa.
