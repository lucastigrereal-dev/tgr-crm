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

## Status
`pwsh ./infra/pilot/status-pilot.ps1`

## Backup com restore drill
`pwsh ./infra/pilot/backup-pilot.ps1`

O backup salva MySQL + documentos privados. O SQL é restaurado em banco temporário e todas as tabelas são comparadas antes do PASS.

## Parar
`pwsh ./infra/pilot/stop-pilot.ps1`

O comando preserva volumes. Não use `docker compose down -v` sem decisão explícita de descarte.

## Limites
- Quick Tunnel pode mudar de URL quando recriado.
- Gateway Asaas real continua desabilitado sem credenciais/autorização.
- OAuth e Forge continuam suportados, mas não são necessários no runtime local de piloto.
- Produção definitiva requer hostname estável, backup externo e observabilidade central.