# TGR CRM — runtime persistente de piloto

Este runtime permite operar o TGR CRM sem depender de OAuth/Forge externos durante o piloto controlado.

## Componentes
- MySQL 8.4 persistente em volume Docker.
- Aplicação compilada em Node 22.23.2.
- Login local seguro, habilitado apenas por variável de ambiente.
- Senha armazenada como hash scrypt; a senha em texto claro fica somente no arquivo local de credenciais ignorado pelo Git.
- Storage privado local em volume Docker, servido somente após autorização do CRM.
- Cloudflare Quick Tunnel para HTTPS temporário do piloto.

## Iniciar
`pwsh ./infra/pilot/start-pilot.ps1`

O script cria segredos locais, constrói a imagem, sobe MySQL, aplica migrations, valida configuração, sobe o app, abre o túnel e exige readiness local e público.

Credencial inicial: `infra/pilot/.pilot-credentials.local.txt`.
URL atual: `infra/pilot/.pilot-url.local.txt`.

### Ponte do Financial (opcional)
Fica desligada enquanto `FINANCIAL_ENDPOINT` e `FINANCIAL_CRM_INTEGRATION_KEY` estiverem vazios. Para ligar, preencha também `FINANCIAL_PROJECT_EXTERNAL_KEY` e `FINANCIAL_PROJECT_NAME` (o fuso padrão é `America/Recife`): com só endpoint e chave, o app recusa subir ("Financial project identity incomplete").

### Piloto na sala (Plano Piloto 3 dias): CRM sem Financial e usuários
- Com `FINANCIAL_ENDPOINT` e `FINANCIAL_CRM_INTEGRATION_KEY` vazios o CRM sobe normalmente e a ponte fica desligada (provado em `server/bridgeConfig.test.ts`). Em `/integracoes` o Financial aparece como "Desligada" e os eventos pendentes acumulam sem perda; ligar depois entrega tudo na ordem.
- Usuários do piloto (login local): `node scripts/pilot-users.mjs --out <pasta fora do repositório> --user ana.adm:admin:"Ana Administrativo" --user bia.fin:finance`. `--perfil-sala` cria os perfis extras do CRM no piloto, com nomes provisórios (o admin geral `lucas.admin` é o `LOCAL_AUTH_USERNAME` do runtime e o script recusa repeti-lo; se o runtime usar outro nome, passe `--primary <nome>`; `gerente.vendas` seller: lê o contrato da ponte, `administrativo` admin: o único papel do CRM que dá baixa, ativa contrato e abre integrações e auditoria; não existe papel "operador"). Gerente de captação e recepção não têm login no CRM (§1.2 do plano). Os nomes reais entram depois com `--user`. Papéis: `admin`, `seller`, `finance`, `service`. O script é idempotente (quem já existe mantém a senha; `--rotate nome` troca uma), grava `crm-users.env` (valor de `LOCAL_AUTH_USERS` para o compose) e as senhas temporárias só em `crm-credentials.local.txt` (modo 600). Nada de senha ou hash no terminal. `--env-name CRM_LOCAL_AUTH_USERS` gera a linha no nome que o compose portátil da Suite (`infra/piloto-portavel`) lê. Para o `start-pilot.ps1` enxergar os usuários, acrescente a linha de `<pasta>/crm-users.env` (já vem `LOCAL_AUTH_USERS='[...]'`, entre aspas simples) ao `infra/pilot/.env.pilot.local` (troque a linha antiga, se houver) e rode o `start-pilot.ps1` de novo: ele só lê esse arquivo e repassa `LOCAL_AUTH_USERS` ao compose. Depois de subir, `node scripts/pilot-login-smoke.mjs --base https://<crm> --credentials <pasta>/crm-credentials.local.txt` confere o login de cada perfil (PASS/FAIL, sem imprimir senha). A troca das senhas temporárias é do Lucas no D3.
- Browser: `e2e/strict-isolated.spec.ts` ("a sala no navegador") prova contrato criado pela ponte, parcelas, baixa manual, auditoria, painel de integrações e estoque.

## Status
`pwsh ./infra/pilot/status-pilot.ps1`

## Backup com restore drill
`pwsh ./infra/pilot/backup-pilot.ps1`

O backup salva MySQL + documentos privados. O SQL é restaurado em banco temporário e todas as tabelas são comparadas antes do PASS.

Linux/CI: `APP_PASSWORD=... DOCUMENTS_VOLUME=tgr-crm-pilot_documents_data bash ./infra/pilot/backup-restore-drill.sh`

Mesmo drill, sem root no banco de origem, com restore em container descartável e comparação de contagem **e** `CHECKSUM TABLE` por tabela.

## Parar
`pwsh ./infra/pilot/stop-pilot.ps1`

O comando preserva volumes. Não use `docker compose down -v` sem decisão explícita de descarte.

## Limites
- Quick Tunnel pode mudar de URL quando recriado.
- Gateway Asaas real continua desabilitado sem credenciais/autorização.
- OAuth e Forge continuam suportados, mas não são necessários no runtime local de piloto.
- Produção definitiva requer hostname estável, backup externo e observabilidade central.