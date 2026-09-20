# TGR CRM — Pilot Runtime Receipt — 20/09/2026

## Fonte de verdade

- Repositório: `lucastigrereal-dev/tgr-crm`
- Base oficial usada pelo runtime: `main` no merge `aec1fb6eec80449c673ef51a1fe748fbdb18624d`
- Branch de finalização do runtime: `pilot/runtime-2026-09-19`
- Node: 22.23.2
- MySQL: 8.4
- Runtime: Docker persistente no KRATOS
- HTTPS de piloto: Cloudflare Quick Tunnel recuperável

## Gate final de código

- TypeScript: PASS
- Vitest: **132/132 arquivos, 427/427 testes PASS**
- Build produção: PASS
- Bundle budget: PASS
- Aplicação crítica: ~149.3 KB gzip / 450 KB
- Excel lazy: ~264.4 KB gzip / 300 KB
- PDF lazy: ~123.4 KB gzip / 150 KB

## Gate E2E isolado final

- Run: `runtime_20260920_final`
- MySQL 8.4 descartável criado para o run
- Migrations do zero: PASS
- Seed determinístico: PASS
- Chromium: **5/5 jornadas PASS**
- Cleanup: `CLEANUP_EXIT=0`
## Autonomia do piloto

O CRM não depende de OAuth externo nem de Forge Storage para funcionar no piloto controlado.

- Login local seguro, desabilitado por padrão no código.
- Senha armazenada como hash scrypt; texto da senha fica apenas em arquivo local ignorado pelo Git.
- Cookie HTTP-only usa a mesma sessão do SDK.
- Rate limit de tentativas no login local.
- OAuth original continua disponível quando houver provedor configurado.
- Storage local privado usa volume Docker persistente.
- Leitura de documento continua exigindo autenticação + autorização por recurso.
- Forge/S3 continua como fallback quando configurado.

## Aceitação pública real

Login local foi exercitado na URL HTTPS do piloto.

**16/16 módulos navegáveis PASS:**
1. Visão geral
2. Sala de vendas
3. Captação
4. Vendas
5. Análise de vendas
6. Campanhas
7. Comissões
8. Financeiro
9. Contratos
10. Clientes
11. Reservas
12. Agenda
13. Saúde da carteira
14. Equipe
15. Configurações
16. Importar
## Operações reais de homologação

No ambiente persistente e público foram executadas operações reais com dados sintéticos:

- criação de cliente: PASS
- Cliente 360: PASS
- interação de relacionamento: PASS
- upload de PDF no storage local privado: PASS
- leitura autenticada do mesmo PDF: PASS
- criação de tarefa: PASS
- auditoria persistida: PASS

Prova de banco antes da limpeza:
- cliente presente
- 1 interação
- 1 documento
- tarefa final em `done`
- admin local persistido
- 7 registros de auditoria relacionados ao fluxo

## Bug encontrado no uso real e encerrado

A Agenda exibia “Concluir” para tarefa `open`, mas o domínio exige `open → in_progress → done`.

Correção:
- `open`: ação primária “Iniciar”
- `in_progress`: ação primária “Concluir”
- estados terminais: sem ação primária
- helper compartilhado `taskPrimaryAction`
- teste de regressão protege a regra
- fluxo público real validado: `open → in_progress → done`
## Persistência e recuperação

- down completo do stack: PASS
- volumes preservados: PASS
- start do zero: PASS
- migrations idempotentes: PASS
- login após restart: PASS
- cliente/interação/documento após restart: PASS
- leitura autenticada do documento após restart: PASS

## Backup e restore

Backup com dados sintéticos:
- **40/40 tabelas verificadas**
- archive do volume de documentos validado
- restore em banco temporário: PASS

Backup da base final limpa:
- manifest: `C:\Users\lucas\Documents\TGR-CRM-Pilot-Backups\manifest-20260920-013657.json`
- **40/40 tabelas verificadas**
- `BACKUP_RESTORE=PASS`

## Estado entregue da base

Depois dos testes, os volumes de piloto foram recriados do zero.

- 40 tabelas de aplicação
- `users = 1` (admin local do piloto)
- `__drizzle_migrations = 38`
- **0 registros operacionais em todas as demais tabelas**

A navegação pública 16/16 foi repetida nessa base limpa.
## Túnel de piloto

Quick Tunnel é aceitável para homologação, não para produção definitiva.

Foi adicionado `infra/pilot/refresh-tunnel.ps1`:
- recria apenas o túnel, sem rebuild do CRM ou MySQL;
- exige DNS em 1.1.1.1 e 8.8.8.8;
- valida `/api/health/ready`;
- tenta múltiplas URLs até obter endpoint público utilizável;
- só então atualiza `.pilot-url.local.txt`.

O `start-pilot.ps1` só retorna `READY=PASS` depois desse gate.

## Bloqueios externos honestos

- cobrança Asaas real: BLOCKED até credenciais, webhook e autorização operacional;
- IA/serviços Forge/Manus: funções que dependem do provedor externo continuam indisponíveis sem credenciais;
- hostname/domínio permanente e infraestrutura 24/7: ainda são etapa de produção;
- Quick Tunnel não é SLA de produção.

## Veredito

**CRM pronto para piloto operacional controlado com banco persistente, login próprio, storage próprio, backup/restore e acesso HTTPS.**

As pendências restantes são fornecedores e infraestrutura de produção, não falhas do núcleo do CRM.
