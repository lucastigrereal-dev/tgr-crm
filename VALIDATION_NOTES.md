# Notas de Validação

## 20 de agosto de 2026 — Sala e análise comercial

- A rota `/sala-de-vendas` renderizou autenticada, com navegação, cards operacionais, filtro por dia e indicação de atualização automática a cada 5 segundos.
- A primeira captura da rota `/analise-de-vendas` ocorreu durante o carregamento inicial do layout, exibindo skeletons. Os logs do navegador não reportaram erro de runtime; é necessária uma nova captura após a consulta tRPC estabilizar.
- A validação estrita de navegador contra banco isolado está preparada no cenário Playwright, mas não foi executada nesta sessão porque `E2E_DATABASE_URL` não está configurada. Nenhum dado de produção foi usado como substituto.

## 20 de agosto de 2026 — Análise de conversão

A rota `/analise-de-vendas` foi validada visualmente após o carregamento da consulta: filtros de período, métricas, funil, leitura rápida e quebra por campanha renderizam corretamente. No recorte sem fichas reais, a interface exibe estados vazios e métricas zeradas de forma explícita, sem gerar números fictícios. Os contratos de métricas, router e interface foram validados por 94 testes automatizados e build de produção.
