# TGR-CRM — Demo Runbook 48h

**Branch:** `demo-ready-2026-08-26`  
**Base main:** `778f43654559eeff10900c3e51457cfa1b39ca3d`  
**Data do freeze:** 2026-08-24

## Objetivo

Transformar o TGR-CRM existente em uma demonstração coerente, segura e defensável sem reescrever a arquitetura. O foco das próximas 48 horas é **Demo Ready**, não paridade integral de produção.

## Regras do freeze

1. Não fazer push/merge direto em `main`.
2. Não usar dados pessoais reais nem credenciais reais de pagamento.
3. Não inventar MDR, taxa de antecipação, percentual final de comissão, prazo total da operação ou provedor de assinatura.
4. Proposta aceita não equivale a venda validada.
5. Comissão automática deve bloquear quando a política do empreendimento estiver incompleta.
6. Nova ideia entra no backlog. Só blocker da apresentação entra nesta branch.

## Seis Golden Paths

1. **Captação → qualificação:** abrir casal/ficha, origem e perfil mínimo sem duplicidade.
2. **Comercial:** casal atendido → oportunidade → proposta.
3. **Governança de preço:** solicitação de desconto → decisão autorizada → trilha de auditoria.
4. **Contrato:** proposta → contrato → parcelas → status → distrato preservando histórico.
5. **Receita:** pagamento/entrada → cobrança → comissão → visão de qualidade da receita.
6. **Cliente 360°:** cadastro → histórico → contrato → financeiro → direito/reserva quando aplicável.

## Fora das 48 horas

- Portal completo do proprietário.
- Credenciais/cartão de produção.
- Assinatura eletrônica de produção ainda não integrada.
- Integração completa PMS/ERP.
- Conversation intelligence.
- Modelos preditivos de cancelamento/ICP sem base histórica suficiente.
- Reescrita para microsserviços ou troca de stack.

## Gate de apresentação

A versão apresentada só pode ser marcada como `demo-ready` se:

- `pnpm check` passar;
- `pnpm test` passar;
- `pnpm build` passar;
- golden paths não tiverem blocker crítico;
- não houver segredo ou PII real na branch;
- a cópia da interface não reivindicar capacidade não comprovada;
- o SHA exato da apresentação estiver registrado aqui.

## Evidência de execução

| Gate | Resultado | Evidência |
|---|---|---|
| Base main registrada | ✅ | `778f43654559eeff10900c3e51457cfa1b39ca3d` |
| Branch isolada criada | ✅ | `demo-ready-2026-08-26` |
| Typecheck | ⏳ | executar antes do RC |
| Vitest | ⏳ | executar antes do RC |
| Build | ⏳ | executar antes do RC |
| E2E golden paths | ⏳ | executar antes do RC |
| Preview estável | ⏳ | selecionar runtime compatível |
| Commit da apresentação | ⏳ | preencher após release gate |
