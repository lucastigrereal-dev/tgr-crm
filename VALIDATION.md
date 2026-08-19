# Validação de Fluxos Críticos

## Checagens executadas

| Verificação | Resultado | Evidência |
|---|---|---|
| Tipagem TypeScript | Aprovada | `pnpm check` sem erros. |
| Testes automatizados | Aprovados | `pnpm test`: 3 arquivos e 9 testes aprovados. |
| Build de produção | Aprovado | `pnpm build` concluiu a geração do cliente e servidor. |
| Inspeção visual | Aprovada | Painel e os módulos de clientes, comercial, contratos, reservas, financeiro, agenda e equipe renderizados no preview. |

## Regras de sucesso e erro verificadas

| Fluxo | Caminho de sucesso | Bloqueio de erro |
|---|---|---|
| Contrato e parcelas | O cronograma reparte o total sem perder centavos. | Rejeita total inválido e número de parcelas inválido. |
| Reserva | Reserva é criada com período válido e vínculo contratual compatível. | Rejeita saída anterior/igual à entrada e conflito de unidade no mesmo período. |
| Agenda financeira | Parcela com vencimento em até sete dias ou vencida gera pendência operacional ao consultar a agenda. | A mesma parcela não duplica tarefa aberta de cobrança. |
| Follow-up comercial | Toda oportunidade cria tarefa de follow-up; sem data informada, o prazo é de 48 horas. | A regra de prazo padrão e a data explícita são cobertas por teste automatizado. |
| Cliente | Cadastro completo pode ser atualizado, com documentos e histórico anexáveis. | Campos de e-mail, tamanho de anexo e identificadores são validados no servidor. |
| Financeiro | Cobrança, baixa, repasse e livro-caixa ficam vinculados ao domínio financeiro. | Perfil sem autorização financeira recebe bloqueio. |
| Acesso | Perfis internos alcançam apenas módulos compatíveis. | Testes cobrem bloqueio de usuário comum no CRM/contratos/agenda; vendedor no financeiro/reservas; atendimento no comercial. |

## Limite deliberado de integração

O sistema registra e audita boleto, PIX, cartão e transferência, porém a **emissão bancária automática** deve ser ativada depois da escolha da instituição ou gateway e do fornecimento das credenciais corporativas. A aplicação não gera código de cobrança fictício; essa decisão evita cobrança inválida ou risco financeiro.
