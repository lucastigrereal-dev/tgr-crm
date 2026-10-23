# F1.8 CRM-a e CRM-b: prefill do GuestPass na ficha (2026-10-23)

Estado: **atrás de `CRM_GUESTPASS_PREFILL_ENABLED=false`**. A migration é **PROPOSTA** (não aplicada). Nada foi ligado nem homologado. Dados de teste 100% sintéticos.

## O que existe
- `migrations/proposed/PROPOSED_0087_capture_guestpass_links.sql` (a 0086 já é o distrato): vínculo único passe-ficha (`captureId` unique, `guestpassPassRef` unique, CHECK do formato `GP-` + 8 ou 10 hexadecimais, 2 FKs). Só ids, sem PII. `drizzle/schema.ts` descreve a tabela (como `couple_registry`).
- `server/guestpassConfig.ts`: flag, base e chave lidas do ambiente na hora da chamada.
- `server/guestpassPrefill.ts`: consulta sob demanda (pull, sem cache nem fila) e serviço de vínculo/candidatos.
- `server/routers/guestpass.ts` (admin e vendedor): `status`, `lookup` (não grava), `link` (vincula um passe a ficha existente).
- `captures.create` aceita `guestpassPassRef` e vincula na MESMA transação da ficha (passe repetido = CONFLICT e a ficha não nasce).
- UI em `Capture.tsx`: "Buscar passe" e preenchimento na hora (`GuestpassLookup.tsx`); só aparece com a flag ligada no servidor; preenche campo vazio, nunca sobrescreve o digitado.

## Contrato consumido (dono: tgr-guestpass)
`guestpass.prefill.v1`, fixture copiada da Suite #148 em `docs/contracts/fixtures/guestpass_prefill_contract.json` e travada por hash no teste (`01580fcd...`, sem `_source`). Lista fechada de campos; qualquer campo proibido (cpf, renda, veículo, notas...) descarta a resposta inteira; o passe devolvido tem que ser o pedido; 404 é uniforme; 429 respeita `Retry-After`.

## Variáveis de ambiente (todas no `.env.example` e no compose)
| Variável | Padrão | Nota |
|---|---|---|
| `CRM_GUESTPASS_PREFILL_ENABLED` | `false` | flag do CRM (a do GuestPass é `GUESTPASS_CRM_PREFILL_ENABLED`, do outro lado) |
| `GUESTPASS_CRM_BASE_URL` | vazio | origem do GuestPass |
| `GUESTPASS_CRM_READ_KEY` | vazio | chave de ponte (Bearer) que o GuestPass valida. **Não** é o token de CI `GUESTPASS_READ_TOKEN`: reaproveitá-lo como Bearer vazaria o token do repositório |
| `GUESTPASS_CRM_TIMEOUT_MS` | `5000` | 500 a 15000 |

## Decisões e limites
- Nunca vincula sozinho por telefone: candidatos (mesmos 8 últimos dígitos, clientes não anonimizados) são só sugestão; a equipe escolhe.
- Nada do casal vai para log nem auditoria (a auditoria guarda só ficha e Nº do passe).
- O contrato NÃO entrou em `tgr-events.snapshot.json`/`consumers.lock.json` de propósito: não mexe no pin Suite<->CRM. Se a Suite quiser fixar a seção, é Suite primeiro, depois CRM, depois re-pin.
- Não coberto: modo nuvem do GuestPass (a rota só existe no servidor local dele), navegador real (Playwright), GuestPass real.

## Para ligar (depois do GO)
1. Aplicar a 0087 (GO do dono do banco). 2. Configurar base e chave no ambiente. 3. Ligar a flag. 4. Conferir com um passe de teste do GuestPass local.
