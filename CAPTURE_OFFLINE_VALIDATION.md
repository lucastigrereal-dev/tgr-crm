# Validação — Fila offline de captação

Em 21 de agosto de 2026, a Central de Captação foi conferida na rota correta `/captacao`. A ficha digital, o seletor de empreendimento e a fila de sala renderizam sem regressão visual. A faixa de sincronização offline permanece oculta quando não existem fichas pendentes, evitando ruído operacional no estado normal.

A implementação usa IndexedDB no navegador para persistir a carga da ficha, uma chave de deduplicação baseada em titular, telefone, empreendimento e horário, e reenvio ao retorno da conexão ou por ação explícita do operador. A deduplicação possui teste unitário; a simulação de navegador realmente offline e o conflito contra backend permanecem pendentes de prova específica.
