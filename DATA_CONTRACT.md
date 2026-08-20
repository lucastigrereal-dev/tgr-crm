# Contrato de dados e eventos — TSE Exclusivo

## Princípios operacionais

O sistema mantém **uma única empresa**, identifica cada agregado por chave numérica e registra datas persistidas em UTC. Valores financeiros são armazenados como `decimal(14,2)` e apresentados em reais somente na interface. Alterações relevantes criam registro de auditoria e, quando forem fato de negócio, evento de domínio append-only.

| Elemento | Contrato | Garantia |
|---|---|---|
| Associado | `customer` com dados cadastrais, status e identificadores de contato | Documento e e-mail são normalizados antes de persistir. |
| Contrato | `contract` vinculado a associado, vendedor e proposta opcional | Criação gera cronograma de parcelas em transação. |
| Parcela | `installment` vinculada ao contrato, com vencimento e situação | Baixa financeira gera evento e transação de receita. |
| Oportunidade e proposta | `opportunity` e `proposal` com campanha, estágio e valores | Criação e mudança comercial possuem eventos padronizados. |
| Lote CSV | `csv_import_batch` e `csv_import_item` com snapshots | Reversão é bloqueada diante de dependência operacional. |
| Evento de domínio | `domain_event` com nome, agregado, ator, payload e data | Não é atualizado nem removido por fluxos de negócio. |

## Catálogo de eventos

Os nomes canônicos vivem em `shared/domainEvents.ts`. Cada entrada declara o agregado correspondente e impede que novas rotas publiquem nomes soltos ou inconsistentes.

| Família | Eventos |
|---|---|
| CRM | `customer.created`, `customer.updated`, `customer.interaction.created`, `customer.document.uploaded` |
| Contratos | `contract.created`, `contract.status.updated`, `contract.document.uploaded` |
| Comercial | `opportunity.created`, `opportunity.updated`, `proposal.created`, `sales.playbook.created` |
| Financeiro | `installment.renegotiation.proposed`, `installment.paid`, `financial.entry.created`, `financial.transfer.created` |
| Operação | `ownership.entitlement.created`, `unit.maintenance.blocked` |

> O evento informa o fato ocorrido; a auditoria fornece a trilha legível da alteração. Relatórios e IA futura devem consultar o evento como histórico imutável e a tabela de negócio como estado atual.

## Limites atuais

O catálogo cobre os fluxos operacionais entregues. Integrações externas futuras devem publicar eventos somente após a transação local estar concluída, com contrato versionado e payload sem dados sensíveis desnecessários.

## Cobertura comprovada

| Fluxo | Auditoria | Evento de domínio | Prova automatizada |
|---|---|---|---|
| Criar e atualizar associado | Sim | `customer.created`, `customer.updated` | `server/customers.events.test.ts` valida ator, agregado e payload. |
| Registrar interação e anexo de associado | Sim | `customer.interaction.created`, `customer.document.uploaded` | `server/customers.events.test.ts` valida o vínculo com associado e ator. |
| Criar contrato e cronograma | Sim | `contract.created` | `server/contracts.events.test.ts` valida valor, parcelas, associado e ator. |
| Alterar status e anexar documento contratual | Sim | `contract.status.updated`, `contract.document.uploaded` | `server/contracts.events.test.ts` valida agregado, payload, auditoria e ator. |
| Comercial: playbook, oportunidade e proposta | Sim | `sales.playbook.created`, `opportunity.created`, `proposal.created` | `server/catalogedEmitters.events.test.ts` valida ator, agregado e payload. |
| Financeiro: acordo, baixa, lançamento e repasse | Sim | `installment.renegotiation.proposed`, `installment.paid`, `financial.entry.created`, `financial.transfer.created` | `server/catalogedEmitters.events.test.ts` valida cada fato financeiro catalogado. |
| Ownership: direito de uso e manutenção | Sim | `ownership.entitlement.created`, `unit.maintenance.blocked` | `server/catalogedEmitters.events.test.ts` valida evento; manutenção também possui auditoria. |

Todos os emissores do catálogo atual possuem teste integrado de evento/auditoria ou teste de domínio associado. O teste E2E autenticado de navegador continua pendente de uma base de homologação descartável; ele complementará, e não substituirá, estas provas integradas controladas.
