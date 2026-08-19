# Arquitetura do TSE CRM Exclusivo

## Princípio de produto

O TSE CRM Exclusivo é um **monólito modular de empresa única**. A aplicação preserva a jornada operacional de timeshare — relacionamento, venda, contrato, cobrança, utilização e atendimento — sem carregar a complexidade de `tenant_id`, administração de múltiplas empresas ou isolamento entre operações.

## Domínios

| Domínio | Responsabilidade | Entidades principais |
|---|---|---|
| Pessoas | Cadastro completo, documentos, contatos e histórico de atendimento. | clientes, documentos, interações |
| Comercial | Funil, propostas, metas e acompanhamento de vendedores. | oportunidades, propostas, metas de vendas |
| Contratos | Formalização do direito contratado e documentação de apoio. | contratos, documentos contratuais, parcelas |
| Inventário e reservas | Unidades, disponibilidade, reservas e estadias. | empreendimentos, unidades, reservas |
| Financeiro | Parcelas, cobranças, recebimentos, repasses e despesas. | parcelas, cobranças, lançamentos, repasses |
| Operação | Agenda, pendências e lembretes de trabalho. | tarefas |
| Governança | Perfis internos e registro de ações críticas. | usuários, trilha de auditoria |

## Perfis de acesso

| Perfil | Escopo principal |
|---|---|
| Administração | Visão e administração integral da operação. |
| Vendas | Clientes, oportunidades, propostas, contratos próprios e metas. |
| Financeiro | Contratos, parcelas, cobranças, repasses, receitas e despesas. |
| Atendimento | Clientes, contratos consultáveis, reservas, interações e tarefas. |

## Regras estruturais

Cada contrato pertence a um cliente principal e pode nascer de uma proposta aprovada. As parcelas são ligadas ao contrato, enquanto uma cobrança pode ser vinculada a uma parcela quando houver boleto, Pix ou outro meio registrado. Reservas vinculam cliente, contrato e unidade, impedindo sobreposição de estadias confirmadas para a mesma unidade. Tarefas conectam pessoas e contratos às rotinas de atendimento, comercial e financeiro.

Os dados sensíveis devem ser tratados com acesso por perfil, dados de documento mascarados nas listagens e anexos mantidos por referência em armazenamento de arquivos. A geração bancária real, assinatura digital e integrações de reservas serão conectores posteriores, pois exigem credenciais, homologação e regras de cada fornecedor.

## Critério de implementação

A primeira versão prioriza fluxos completos, navegáveis e rastreáveis: cadastrar cliente, abrir oportunidade, registrar proposta, criar contrato, lançar parcelas, reservar unidade e acompanhar tarefas. Não vamos tentar recriar as centenas de telas do legado, porque isso seria construir uma rodoviária inteira para vender uma passagem.
