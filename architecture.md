# Arquitetura do TGR-CRM

## Princípio de produto

O TGR-CRM é o **sistema operacional comercial e de relacionamento de uma empresa de multipropriedade**, estruturado como monólito modular para preservar velocidade de desenvolvimento, transações simples e uma única fonte de verdade. A mesma empresa pode operar múltiplos empreendimentos/projetos com regras próprias de produto, comissão, documentação e operação.

A arquitetura não tenta transformar o produto em uma plataforma genérica de CRM. O domínio central é a jornada de multipropriedade: captação, qualificação, venda, formalização, recebimento, comissão, carteira, utilização, reserva, cobrança, pós-venda e governança.

## Regra-mãe de negócio

**Venda comercial, contrato, caixa e qualidade são fatos diferentes.** O sistema deve distinguir explicitamente:

1. oportunidade em negociação;
2. proposta enviada/aceita;
3. contrato emitido/assinado;
4. venda em validação;
5. venda validada;
6. pagamento/entrada confirmados;
7. contrato ativo;
8. contrato em risco, inadimplente, cancelado ou encerrado;
9. venda madura por coorte.

Nenhum KPI financeiro deve inferir caixa recebido apenas a partir do estágio comercial.

## Domínios

| Domínio | Responsabilidade | Entidades principais |
|---|---|---|
| Pessoas e household | Cadastro, casal/família, documentos, contatos e histórico. | clientes, interações, documentos, fichas |
| Captação | Origem, campanha, qualificação, agendamento e comparecimento. | fichas de captação, campanhas, responsáveis |
| Comercial | Oportunidades, propostas, desconto, metas e playbooks. | oportunidades, propostas, aprovações, metas |
| Contratos | Formalização, versão documental, direitos e ciclo contratual. | contratos, documentos, parcelas, direitos |
| Receita e financeiro | Entrada, parcelas, cobrança, recebimentos, repasses, comissões e qualidade de receita. | parcelas, cobranças, transações, comissões, ledger |
| Inventário e reservas | Empreendimentos, unidades, disponibilidade, direitos, reservas e estadias. | resorts, unidades, entitlements, reservas |
| Relacionamento e pós-venda | Interações, onboarding, tarefas, retenção e acompanhamento de carteira. | interações, tarefas, casos e eventos |
| Dados e inteligência | Eventos, read models, scorecards, cohorts, KPIs e IA permissionada. | domain events, audit logs, ledgers e read models |
| Governança | Identidade, permissões, políticas por empreendimento e auditoria. | usuários, papéis, políticas, trilha de auditoria |

## Projetos e regras

Cada empreendimento possui parâmetros próprios. Regras comerciais e financeiras não devem ficar escondidas em constantes do código. Comissão, cancelamento, documentação obrigatória, papéis e campos de ficha devem ser configuráveis, validados e auditáveis.

Valores ainda não aprovados ficam explicitamente em estado **PENDENTE**. A ausência de uma política financeira válida deve bloquear a automação relacionada em vez de recorrer silenciosamente a valores históricos.

## Segurança e acesso

A autorização ocorre no servidor. Esconder botão no frontend não é controle de acesso. Documentos e arquivos sensíveis exigem autenticação, escopo de recurso e trilha de acesso. Perfis devem evoluir de papéis genéricos para capacidades coerentes com a operação: administração, captação, recepção, consultor/liner, fechador, gerente, financeiro, contratos/pós-venda e atendimento.

## Integrações

O core mantém contratos estáveis de integração. Gateway de pagamento, assinatura eletrônica, ERP/PMS, WhatsApp e outros fornecedores entram por adaptadores. Escritas financeiras e contratuais devem ser idempotentes, reconciliáveis e auditáveis.

## Dados e IA

Eventos de domínio preservam o que ocorreu e quando. Tabelas operacionais mantêm o estado atual. Ledgers e read models derivam verdade econômica e scorecards sem transformar o banco transacional em BI improvisado.

IA é uma camada de assistência: busca, resumo, explicação, recomendação e análise. A IA não aprova desconto, distrato, pagamento ou comissão de forma autônoma.

## Critério de implementação

Prioridade permanente:

**fluxo real → dado mínimo correto → rastreabilidade → dashboard → inteligência.**

Não reconstruir o sistema para imitar centenas de telas legadas. A paridade funcional será medida por capacidade e resultado operacional, não por quantidade de formulários.
