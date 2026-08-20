# Limites de validação operacional

## Comprovado nesta base

O projeto executa checagem de tipos e 33 testes automatizados de regras de domínio, permissões, CSV, funil, comissão, autenticação, reversão controlada e exportação. O backend valida formato de importação, relatórios de erro e filtros comerciais sem depender do navegador.

A reversão foi exercitada com uma infraestrutura de banco controlada: associados criados são removidos, associados atualizados recuperam o snapshot anterior, contratos importados são removidos junto das parcelas quando não há dependências, e documentos, reservas, tarefas, cobranças, lançamentos financeiros ou contratos dependentes bloqueiam a exclusão. A exportação filtrada possui contrato determinístico para etapa, dados da proposta, data e nome do arquivo, além de testes que comprovam a entrega dessas linhas aos escritores XLSX e PDF.

## Deliberadamente não executado no banco ativo

A reversão de um lote CSV altera associados, contratos e parcelas. A execução de uma carga artificial, seguida de reversão, não será feita no banco operacional compartilhado. A mesma cautela vale para uma sessão autenticada de navegador disparar downloads em massa.

## Condição para E2E completo

Para comprovar reversão e downloads em navegador de ponta a ponta, o projeto precisa de um ambiente de homologação isolado, usuário de teste e dados descartáveis. O runner Playwright e Chromium já estão instalados; falta apenas essa fronteira de dados segura.
