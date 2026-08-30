# TGR CRM — Matriz E2E

Execução de referência: GitHub Actions `33291030111`, job `99202568403`, SHA `081ddc0b9f1cb3b2460011f025e0fae3d74fb43a`.

| Jornada | Resultado | Prova |
| --- | --- | --- |
| CSV: prévia, importação e undo protegido | PASS | Playwright estrito e leitura MySQL sem registro importado após undo. |
| Funil: download XLSX e PDF | PASS | Playwright estrito confirmou downloads reais. |
| Reserva: check-in, acompanhante, fila e check-out | PASS | Mutação tRPC concluída e `reservation_guests.checkedInAt/checkedOutAt` persistidos. |
| Sala: chegada, mesa, liner, fechador, tour e sem-tour | PASS | Playwright estrito e leitura MySQL dos estados finais. |
| Contrato: solicitação, aprovação e execução única de distrato | PASS | Cenário autenticado estrito passou. |
| Banco descartável exclusivo do run | PASS | `E2E_RUN_ID`, confirmação explícita e nome de banco de propriedade do run validados antes da criação. |
| Limpeza sem resíduo | PASS | CI executou `Drop only this run-owned database` com sucesso. |
| Gateway real | BLOCKED | Nenhuma credencial ou cobrança real foi usada. |

Os fixtures usam o prefixo `E2E-TGR-`; a infraestrutura foi MySQL 8.4 descartável do GitHub Actions.
