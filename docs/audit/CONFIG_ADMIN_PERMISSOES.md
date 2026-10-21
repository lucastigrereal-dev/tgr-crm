# Configuração do admin: permissões por papel (item 4)

Editável por AÇÃO (capacidade), atrás de `PERMISSION_OVERRIDES_ENABLED=false`, com histórico (`role_permission_overrides`, PROPOSED_0085) e auditoria.

Editáveis, todas ligadas de verdade na autorização do servidor:
- `export.pii`: exportação da ficha com CPF (`captureSheet.export`).
- `sheet.archived.open`: ficha arquivada (casal que não comprou) fora da vista da sala (`canOpenArchivedSheet`).
- `document.read`: leitura de documento de cliente/contrato (`storageAccess.authorizeStorageRead`).
- `commission.view`: consulta de comissões (`commissionsProcedure`: scorecards e overview). Conceder a um papel sem escopo próprio mostra todas, como o finance.

Piso fixo: o admin está sempre em toda lista (lista vazia = só admin); as demais capacidades (validar venda, pagar comissão, distrato, financeiro, assinar documento...) não são editáveis; papel desconhecido é descartado. A mesma sanitização roda no servidor e no navegador.

**Telas ficam FIXAS por enquanto.** Esconder um item do menu não fecha a rota digitada nem a API, então um override de tela mostraria um efeito que não existe. Fechar rota e procedures por tela é um PR próprio; até lá `menuPathRoles` é o único padrão.
