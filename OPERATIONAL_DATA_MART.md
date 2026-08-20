# Data Mart Operacional — TSE Exclusivo

## Propósito

O **data mart operacional lógico** atende decisões de curto ciclo com uma leitura governada de exceções, adoção e indicadores da operação. Ele é implementado pela consulta `dashboard.operationalPulse`, atualizada no cliente a cada 30 segundos, sem duplicar dados transacionais ou criar cópias manuais de planilha.

## Grão e fontes

| Leitura | Grão | Fontes transacionais | Regra de uso |
|---|---|---|---|
| Exceção financeira | Parcela | Parcelas, contratos, associados | Parcela aberta vencida ou em atraso |
| Exceção comercial | Tarefa | Tarefas, associados | Follow-up aberto ou em andamento com prazo vencido |
| Exceção de inventário | Bloqueio de unidade | Bloqueios de manutenção | Bloqueio planejado ou ativo |
| Exceção de atendimento | Entrada de fila | Lista de espera, associados | Oferta expirada sem conversão |
| Adoção | Evento/ator em 30 dias | Eventos de domínio, interações | Eventos, operadores únicos e interações registradas |

## Contrato de leitura

O painel retorna apenas dados derivados e identificáveis: severidade, módulo, título e descrição da exceção; e contagens de adoção. O dado transacional original continua como fonte de verdade. O componente puro `buildOperationalInsights` é coberto por teste unitário e o router aplica as fontes tipadas.

> A primeira versão é um **data mart virtual**, apropriado ao volume atual. Quando a operação exigir janelas maiores, histórico consolidado ou alta concorrência, a evolução segura é materializar a mesma estrutura em tabela de leitura incremental, mantendo este contrato de saída.
