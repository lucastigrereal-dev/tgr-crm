# Revisão de segurança formal do CRM (CRM-A26), 2026-10-20

Escopo: superfície HTTP (Express/tRPC), sessão e cookie, cabeçalhos, webhooks e pontes por chave, portal por token, storage, dependências, injeção, front (XSS). Método: leitura do código e das rotas públicas, `pnpm audit --prod`, busca por `sql.raw`/`eval`/`dangerouslySetInnerHTML`, provas executáveis em `server/securityReview.test.ts`. Dados sintéticos; nada em banco real.

## Achados e tratamento

| Id | Severidade | Achado | Tratamento | Prova |
| --- | --- | --- | --- | --- |
| A26-1 | média | Respostas de `/api/trpc` e do portal por token (`ownerPortal.view`) não traziam `Cache-Control`; dado de sessão ou do associado podia ficar em cache de navegador/proxy. | CORRIGIDO: `apiNoStore` põe `no-store` em toda resposta de `/api/*` que não define o seu (SSE e storage mantêm). | `securityReview.test` A26-1 |
| A26-2 | baixa | Cookie Secure só era provado por unitário da função; faltava prova na resposta HTTP. | TESTE: Set-Cookie real tem HttpOnly + SameSite=Lax; Secure só com HTTPS direto ou `X-Forwarded-Proto: https`; nunca SameSite=None. | `securityReview.test` A26-2 |
| A26-3 | baixa (defesa em profundidade) | Só `SameSite=Lax` protegia contra CSRF em mutação. | CORRIGIDO como opção: `CSRF_ORIGIN_CHECK_ENABLED` (padrão false) recusa 403 mutação em `/api/trpc` com Origin de terceiros; `CSRF_ALLOWED_ORIGINS` para origens extras; sem Origin passa. Ligar depois do HTTPS/domínio definitivo. | `securityReview.test` A26-3 |
| A26-4 | alta (dependência) | `follow-redirects` 1.16.0 (via axios) com 2 avisos high (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c). | CORRIGIDO: override 1.16.1 em `pnpm-workspace.yaml`; `pnpm audit --prod` sem vulnerabilidades. | `pnpm audit --prod` |

## Verificado sem achado

- Cabeçalhos: nosniff, X-Frame-Options DENY, HSTS e CSP em produção (script só por hash, `frame-ancestors 'none'`, `object-src 'none'`).
- Login local: limite de tentativas por IP+usuário, mapas com teto de memória; `TRUST_PROXY_HOPS` explícito (padrão sem proxy confiável).
- Rotas públicas do tRPC: só `auth.*` e `ownerPortal.view` (token de 256 bits, só o SHA-256 no banco, expira e revoga, sem CPF/endereço).
- Webhooks e pontes por chave: comparação com `timingSafeEqual` (Clicksign, Asaas, Sales, NQ, tempos de encontro); NQ continua desligado por padrão.
- Storage: autorização por recurso antes de ler; chave decodificada validada; `no-store`.
- SQL: nenhum `sql.raw` com entrada; `dangerouslySetInnerHTML` só em `chart.tsx` com cores de configuração estática.
- Sala de vendas (SSE): restrita a admin/seller/service.

## Aceito / fora do alcance

- Limite de conexões simultâneas no SSE da sala: risco baixo, atrás de autenticação por perfil; fica como melhoria.
- HTTPS em si e domínio: Hostinger, do Lucas. O teste de Secure já cobre o comportamento quando houver HTTPS.
- Teste de intrusão externo e revisão por terceiros: não executados aqui.
