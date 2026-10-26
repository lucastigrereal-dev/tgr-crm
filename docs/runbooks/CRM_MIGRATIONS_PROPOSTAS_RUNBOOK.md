# Runbook: aplicar as migrations PROPOSTAS do CRM (0078–0090; 0091 à parte)

Estado: **PRONTO, NADA APLICADO**. SEM CI DO GITHUB. Autorização do Lucas (26/10/2026, escrita por ele no projeto): mudanças no banco real do TGR **sempre com backup, volta pronta e GO do Opus**, sem perguntar de novo. Este runbook é o "com backup e volta pronta"; o GO do Opus no runbook vai na referência `--go` e fica no log.

## O que existe
- `scripts/proposed-migration.mjs` (`status`, `apply NNNN`, `rollback NNNN`), provado em banco descartável por `server/proposedMigrationScript.mysql.test.ts`: 0078→0091 aplicadas uma por vez, fumaça, volta em ordem inversa, reaplicação, recusas.
- O backup é o do piloto: `infra/pilot/backup-pilot.ps1` (dump + documentos + **restore drill** com contagem de todas as tabelas). Só gera o `manifest-*.json` se o restore passou.

## Travas do script (não dá para pular)
1. Só conecta em `127.0.0.1`/`localhost` (o piloto expõe o MySQL em `127.0.0.1:44326`).
2. `apply` e `rollback` exigem `--backup-manifest` com: arquivo existente, **até 60 min**, `.sql` presente com **hash conferido**, tabelas verificadas > 0.
3. Exigem `--go "<referência do GO do Opus>"` (vai para o log).
4. **Uma por vez e em ordem**: a N só roda se todas as menores estão aplicadas; "aplicada pela metade" para tudo.
5. **Fumaça depois de cada apply**: todos os objetos existem, tabelas novas nascem **vazias**, e a contagem de linhas de **todas as tabelas antigas é idêntica** à de antes.
6. **Volta** só na ordem inversa e só se os objetos novos estiverem sem dado (tabela nova vazia; coluna nova só com o valor padrão; enum sem linhas no valor novo). Dado real não se apaga: se houver, recusa e chama o Opus.
7. Log em `tgr-crm-migration-logs/migration-log.jsonl` (início, fim, GO, backup, fumaça, falha).
8. Nunca `drizzle-kit push`. Sem `docker compose down -v`.

## Passo a passo (por migration N, de 0078 até 0090)
1. `pwsh ./infra/pilot/status-pilot.ps1` (app e banco de pé).
2. `pwsh ./infra/pilot/backup-pilot.ps1` → deve imprimir `BACKUP_RESTORE=PASS` e `BACKUP_MANIFEST=<caminho>`. Sem PASS, **para**.
3. `DATABASE_URL=mysql://tgr_app:<MYSQL_APP_PASSWORD>@127.0.0.1:44326/tgr_crm_pilot` (a senha está em `infra/pilot/.env.pilot.local`; não imprimir nem commitar).
4. `node scripts/proposed-migration.mjs apply N --backup-manifest <manifest> --go "<GO Opus>"` → `APPLY=OK`.
5. `node scripts/proposed-migration.mjs status` mostra N como APLICADA; `pwsh ./infra/pilot/status-pilot.ps1` segue saudável.
6. Próxima N.

## Se der ruim
- `apply` falhou: o script mostra o estado. Se ficou **PARCIAL**, `rollback N` (tabelas novas estão vazias) e **parar e chamar o Opus**. Se ficou "nada aplicado", parar e chamar o Opus.
- Fumaça reprovada ou app doente depois: `rollback N` com o mesmo manifest (ou outro novo), na ordem inversa se mais de uma foi aplicada.
- Rollback recusado por dado: **não forçar**. Restaurar o dump do manifest só com GO do Opus e do Lucas (o dump é de antes da migration; qualquer dado novo depois dele se perde).

## 0091 (ficha do captador v2) — separada
Só quando for ligar `CAPTURE_FICHA_V2_ENABLED`. Mesmo procedimento (`apply 0091`). Depois de aplicada, ligar a flag no `.env.pilot.local` e reiniciar só o app. Volta: `rollback 0091` (a flag tem que estar desligada antes). O prefill do GuestPass (`CRM_GUESTPASS_PREFILL_ENABLED`) só liga depois da decisão 3 (consentimento) e da 0087 aplicada.

## O que NÃO é migration
Ligar flags (RECEPTION_CAPTURE_CREATE_ENABLED, COMMISSION_POLICY_VERSIONING_ENABLED etc.) é decisão separada, uma por vez, depois das migrations e com teste de fumaça de tela.
