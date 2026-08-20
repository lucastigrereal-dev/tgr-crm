# Validação — Campanhas e Importação

Em 20 de agosto de 2026, a Central de Campanhas foi validada visualmente com o campo de meta monetária no cadastro de campanha, o cartão consolidado de meta e a indicação explícita de atualização automática a cada 15 segundos. O cálculo de progresso é puro e testado: apresenta atingimento, distância para a meta e superação sem ocultar percentual acima de 100%.

Na Central de Importação, três cartões de acesso rápido para associados, contratos/parcelas e empreendimentos/unidades foram validados visualmente. Cada cartão explica a carga, seleciona o tipo e permite baixar o CSV correspondente. O estado vazio permanece explícito e não introduz dados artificiais.

As alterações passaram por TypeScript, teste unitário do cálculo de campanha, suíte completa com 96 testes e build de produção. A migração `0014_tired_zeigeist.sql` foi aplicada e adicionou somente `sales_campaigns.targetAmount` com padrão seguro de zero.
