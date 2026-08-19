# Limites de validação operacional

## Comprovado nesta base

O projeto executa checagem de tipos e 23 testes automatizados de regras de domínio, permissões, CSV, funil, comissão e autenticação. O backend valida formato de importação, relatórios de erro e filtros comerciais sem depender do navegador.

## Deliberadamente não executado no banco ativo

A reversão de um lote CSV altera associados, contratos e parcelas. A execução de uma carga artificial, seguida de reversão, não será feita no banco operacional compartilhado. A mesma cautela vale para uma sessão autenticada de navegador disparar downloads em massa.

## Condição para E2E completo

Para comprovar reversão e downloads em navegador de ponta a ponta, o projeto precisa de um ambiente de homologação isolado, usuário de teste e dados descartáveis. O runner Playwright e Chromium já estão instalados; falta apenas essa fronteira de dados segura.
