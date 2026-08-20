# Limites de validação operacional

## Comprovado nesta base

O projeto executa checagem de tipos e **71 testes automatizados** de regras de domínio, permissões, CSV, funil, comissão, autenticação, reversão controlada, exportação, inventário, lista de espera, acompanhantes, segurança, integração, analytics e IA permissionada. O backend valida formato de importação, relatórios de erro, filtros comerciais, conversão da fila em reserva e check-in/check-out de acompanhantes sem depender do navegador.

A reversão foi exercitada com uma infraestrutura de banco controlada: associados criados são removidos, associados atualizados recuperam o snapshot anterior, contratos importados são removidos junto das parcelas quando não há dependências, e documentos, reservas, tarefas, cobranças, lançamentos financeiros ou contratos dependentes bloqueiam a exclusão. A exportação filtrada possui contrato determinístico para etapa, dados da proposta, data e nome do arquivo, além de testes que comprovam a entrega dessas linhas aos escritores XLSX e PDF.

## Deliberadamente não executado no banco ativo

A reversão de um lote CSV altera associados, contratos e parcelas. A execução de uma carga artificial, seguida de reversão, não será feita no banco operacional compartilhado. A mesma cautela vale para uma sessão autenticada de navegador disparar downloads em massa.

## Condição para E2E completo

O projeto possui Playwright configurado com uma sessão de proprietário legítima e efêmera, criada pelo próprio SDK e nunca gravada no repositório. **Nove testes autenticados de navegador** confirmam: Central de Reservas, vínculo contratual na fila, central de relacionamento, copiloto de IA, drill-down do dashboard, navegação por teclado, download real de XLSX/PDF filtrado, confirmação visual de reversão CSV e a jornada de oferta para reserva com presença de acompanhante.

As respostas tRPC dos E2Es regulares de reversão, download e reserva são controladas no navegador, para comprovar interface e arquivo sem semear registros artificiais. Além disso, **três E2Es estritos** foram executados contra backend e MySQL descartável isolados: importação/reversão de CSV, download real de XLSX/PDF e jornada waiting → offered → reserva → check-in → acompanhante → check-out. O laboratório foi limpo ao final da validação.
