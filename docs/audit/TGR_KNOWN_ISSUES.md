# TGR CRM — Questões conhecidas

| Item | Resultado | Evidência e encaminhamento |
| --- | --- | --- |
| Gateway/cobrança Asaas real | BLOCKED | Núcleo e webhooks têm cobertura, mas cobrança real exige credenciais, webhook e autorização operacional. |
| IA/serviços Forge/Manus | BLOCKED PARCIAL | Funções dependentes do provedor externo permanecem indisponíveis sem credenciais. O CRM core, login e documentos do piloto não dependem mais deles. |
| Storage de documentos no piloto | PASS | Storage local privado em volume persistente, leitura autenticada/autorizada e backup do volume validados. Forge/S3 permanece fallback opcional. |
| Login de piloto | PASS | Login local scrypt, cookie HTTP-only e rate limit validados. OAuth externo permanece opcional. |
| E2E Windows | PASS | Run final `runtime_20260920_final`: 5/5 Chromium, cleanup 0. |
| Agenda/tarefas | PASS | Bug de `open → done` encontrado no uso real e corrigido para `open → in_progress → done`, com teste de regressão. |
| Quick Tunnel | PILOT ONLY | Recuperação automática via `refresh-tunnel.ps1`. Não oferece SLA; produção requer hostname/túnel permanente. |
| Aviso de chunk >500 kB | ACCEPTED | Budget gzip verde: app ~149.3 KB/450 KB, Excel ~264.4/300 KB, PDF ~123.4/150 KB. |
| Produção 24/7 | BLOCKED | Requer infraestrutura estável, domínio/HTTPS gerenciado, backup externo e observabilidade central. |

Última verificação: 20/09/2026. Consulte `TGR_PILOT_RUNTIME_RECEIPT_2026-09-20.md`.