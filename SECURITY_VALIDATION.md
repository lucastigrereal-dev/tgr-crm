# Validação de Segurança e Qualidade — TSE Exclusivo

## Escopo validado

| Área | Medida aplicada | Evidência |
|---|---|---|
| Servidor HTTP | `X-Content-Type-Options`, anti-frame, política de permissões, referrer policy, isolamento de opener, HSTS em produção e remoção de `X-Powered-By` | `securityHeaders.test.ts` |
| Entrada | Corpo JSON e URL-encoded limitados a 12 MB; URL-encoded limitado a 100 parâmetros | `server/_core/index.ts` |
| Dependências | Atualizados Express 5, tRPC 11.18, AWS SDK, Axios, Drizzle, Streamdown, Nanoid e Lodash 4.18.1 | `pnpm audit --prod` executado após atualização |
| Exportação | SheetJS removido; geração XLSX passou a usar ExcelJS e é testada | `funnelExport.test.ts` |
| Acessibilidade | Atalho de teclado para conteúdo principal e foco verificável | Playwright `accessibility-navigation.authenticated.spec.ts` |
| Fluxos | Regras, permissões, eventos, reservas, financeiro, CRM e integração | Vitest e Playwright autenticado |
| Performance | Orçamento executável para bundle crítico e exportadores em lazy-load | `pnpm test:performance` |

## Resultado de dependências

Após as atualizações, a auditoria de produção apontou apenas um advisory residual: `uuid@8.3.2`, dependência transitiva do ExcelJS. O uso interno identificado no ExcelJS é exclusivamente `v4()` para regras de formatação; o advisory remanescente refere-se a escritas em buffer externo em `v3()`, `v5()` e `v6()`, caminhos não expostos nem usados pelo exportador do TSE. O XLSX é gerado apenas a partir de linhas já validadas do funil e não há leitura de planilhas arbitrárias nesse fluxo.

> A mitigação atual é consciente e limitada: manter o ExcelJS restrito à **exportação**. Uma atualização do ExcelJS que absorva UUID corrigido deve ser revisada na próxima manutenção de dependências.

## Orçamento de performance

O build de produção é verificado por `pnpm test:performance`. Na validação atual, o app crítico ficou em **381,5 KB gzip** (limite 450 KB), ExcelJS foi carregado sob demanda em **264,9 KB gzip** (limite 300 KB) e jsPDF sob demanda em **125,7 KB gzip** (limite 150 KB). Excel e PDF não participam do carregamento inicial do dashboard.

## Limites declarados

Os testes não substituem pentest externo, análise de infraestrutura de hospedagem, controle de domínio, gateway bancário ou homologação com dados operacionais de produção. Eles comprovam o contrato e os comportamentos do aplicativo sob ambiente controlado.
