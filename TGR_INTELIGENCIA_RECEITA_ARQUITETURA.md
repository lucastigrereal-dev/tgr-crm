# TGR-CRM — arquitetura de inteligência profissional, receita e risco

## Tese operacional

O TGR não medirá apenas “quem vendeu”. Ele medirá **quem trouxe casal qualificado, quem conduziu a experiência, quem formalizou, qual regra gerou comissão, quando o dinheiro entrou e se a venda sobreviveu**. Cada papel recebe crédito compatível com sua atuação; cada indicador aponta para eventos e evidências que permitem conferência humana.

> Fechamento sem entrada, documentação, maturação e carteira saudável é sinal comercial — não é receita confirmada, nem performance definitiva.

## A chave que falta: verdade econômica única por venda

Hoje o TGR já possui oportunidade, proposta, contrato, parcela, comissão, lançamento financeiro e distrato. A próxima camada não substitui essas tabelas: cria um **read model derivado** que organiza o ciclo econômico de uma venda e torna a leitura consistente em todos os painéis.

| Medida | Definição operacional | Fonte primária | Nunca deve ser confundida com |
| --- | --- | --- |
| VGV bruto formalizado | Soma dos contratos formalizados no recorte, antes de perdas futuras | Contrato/proposta | Caixa recebido |
| Entrada prevista | Valor de entrada registrado na proposta ou cronograma | Proposta/parcelas | Entrada paga |
| Caixa confirmado | Parcelas efetivamente baixadas/recebidas | Parcelas e lançamentos | Valor prometido |
| VGV em risco | Parte ainda sujeita a atraso, documentação pendente, janela de cancelamento ou score explicável | Eventos, contrato, parcelas e regras | Distrato já realizado |
| VGV líquido realizado | Valor formalizado menos reversões/distratos efetivamente executados no período de análise | Contrato, distrato e financeiro | Previsão probabilística |
| Venda madura | Venda que passou pelo marco configurável por empreendimento — por exemplo, entrada confirmada, primeira parcela, janela de distrato ou combinação | Política versionada por projeto | Venda nova sem histórico |
| Comissão prevista | Comissão calculada por regra versionada antes da condição financeira de liberação | Comissão | Comissão liberada/paga |
| Comissão em risco | Comissão associada a venda sem lastro, atraso, pendência documental ou risco de distrato | Comissão + ledger de qualidade | Estorno efetivado |
| Comissão liberada/paga | Comissão que atravessou as regras de elegibilidade e foi liberada ou quitada | Comissão + financeiro | Estimativa de borderô |

## Modelo de dados proposto

Nenhuma tabela proposta abaixo grava dinheiro “por fora”. Elas materializam fatos derivados e preservam as tabelas transacionais existentes como fonte de verdade.

| Entidade proposta | Grão | Campos críticos | Uso |
| --- | --- | --- | --- |
| `commercial_role_attributions` | Participação de uma pessoa em uma venda/captação/contrato, válida num intervalo | entidade, pessoa, papel, origem, peso, início/fim, aprovado por, evidência | Crédito justo por captador, qualificador, liner, fechador, FTB, gerente e sucessões de carteira |
| `revenue_quality_ledger` | Um fato econômico imutável por contrato/parcela/evento | contrato, parcela, tipo de fato, valor, moeda, evento-fonte, regra-versão, status de qualidade, ocorrido em | VGV, entrada, perda, retenção, reembolso, caixa e exposição em uma linha temporal explicável |
| `commercial_policy_versions` | Uma versão aprovada de política comercial por empreendimento | empreendimento, tipo de política, versão, vigência, conteúdo, aprovado por | Comissão, maturação, alçada, documentação e coorte não mudam retroativamente sem trilha |
| `pipeline_snapshots` | Foto de oportunidade no corte diário ou no gatilho relevante | oportunidade, estágio, valor, probabilidade, dono, campanha, sala, capturado em | Pipeline coverage, forecast e acurácia histórica |
| `professional_scorecards` | Métrica agregada por papel, pessoa, período e coorte | papel, usuário, período, população, métrica, numerador, denominador, cobertura, definição-versão | Painel individual sem fórmula escondida |
| `integrity_cases` | Caso de alerta aberto a partir de evidência | tipo, severidade, entidade, evidência, dono, prazo, estado, decisão | Exceções de venda, comissão, desconto, duplicidade e manipulação com rota real |
| `commission_disputes` | Contestação formal de uma comissão | comissão, parte reclamante, motivo, valor contestado, evidência, decisão, SLA | Transparência de borderô e resolução auditável |

### Regras de integridade do modelo

1. `revenue_quality_ledger` deve ser **append-only**: correção ocorre por novo fato compensatório, nunca por apagar o passado.
2. Toda projeção carrega `sourceEventId`, `policyVersionId` e `calculatedAt` para explicar sua origem.
3. Uma comissão não pode ser “paga” pela projeção; a projeção somente espelha e sinaliza o estado da comissão transacional.
4. O FTB recebe participação exclusiva quando a política comercial o define, preservando a regra atual de não somar liner + fechador de forma indevida.
5. Scorecards exibem população e cobertura: sem número mínimo de vendas maduras, o sistema informa “amostra insuficiente”, em vez de coroar campeão por meia dúzia de negócio.

## Scorecards por papel

| Papel | Métricas de produção | Métricas de qualidade | Métricas de integridade | Antídoto contra ranking burro |
| --- | --- | --- | --- | --- |
| Captador | Captações válidas, agendamentos, comparecimento | Qualificação que vira proposta, venda madura e retenção por coorte | Duplicidade, ficha incompleta, origem inconsistente | Não premiar volume de casal que não tem perfil ou vira distrato |
| Recepção/qualificador | SLA de chegada, tempo de espera, qualificação concluída | Conversão dos qualificados para tour/proposta | Check-in sem identificação, distribuição sem critério | Não confundir fila cheia com operação boa |
| Liner/consultor | Tour→proposta, proposta→negociação, ticket apresentado | Venda madura, entrada confirmada, distrato e inadimplência da coorte | Playbook/documentação quando houver evidência | Não premiar pressão de fechamento que implode a carteira |
| Fechador | Negociação→contrato, fechamento por mesa/turno | Sobrevivência da venda, qualidade da entrada, baixo retrabalho contratual | Desconto aprovado, contrato e assinatura completos | Não chamar assinatura frágil de venda excelente |
| FTB | Conversão e qualidade no mesmo fato comercial | Mesmas métricas do ciclo completo, sem dupla contagem | Papel exclusivo comprovado na atribuição | Não somar duas comissões como se fossem duas pessoas |
| Gerente de sala | Produtividade, cobertura, tempo de resposta, capacidade de mesa | Qualidade média da equipe e evolução de coorte | Equidade de mesa, exceções tratadas, descontos aprovados | Não atribuir ao gerente somente o volume herdado |
| Financeiro/cobrança | Baixa, recuperação, prazo de resolução | Aging, promessa cumprida, gap de caixa reduzido | Comissão sem lastro, conciliação e exceção em SLA | Não jogar atraso de venda ruim no colo da cobrança |

## Alertas prioritários: evidência, dono e rota

| Alerta | Evidência mínima | Responsável inicial | Ação esperada | Bloqueia dinheiro? |
| --- | --- | --- | --- | --- |
| Comissão sem entrada confirmada | Comissão prevista + parcela de entrada aberta/ausente | Financeiro comercial | Revisar elegibilidade e travar liberação conforme política | Sim, se política exigir |
| Venda sem checklist documental | Contrato sem itens obrigatórios aprovados | Contratos/jurídico | Solicitar pendência antes da comissão/ativação | Configurável |
| Desconto fora da alçada | Proposta com percentual acima da política e sem decisão válida | Gerente de sala | Aprovar, rejeitar ou corrigir proposta | Sim |
| Duplicidade provável de casal | Match exato ou fuzzy com explicação | RevOps/recepção | Mesclar ou justificar registros distintos | Não automaticamente |
| Reabertura ou fechamento anômalo | Mudanças repetidas de estágio / concentração temporal | RevOps/auditoria | Revisar trilha e classificar ocorrência | Não automaticamente |
| Mesa com distribuição fora do padrão | Sala, mesa, horário, consultor e população comparável | Gerente/diretoria | Investigar critério de distribuição | Não automaticamente |
| Distrato fora de prazo ou retenção em exceção | Solicitação, política vigente, parcela paga e prazo | Jurídico/financeiro | Validar cálculo e devolução | Sim, para execução |
| Qualidade de carteira abaixo do esperado | Coorte madura com distrato/inadimplência fora da faixa | Diretor comercial | Rever origem, playbook, produto e incentivo | Não automaticamente |

## Evento mestre normalizado

O catálogo atual de eventos de domínio deve evoluir sem quebra de compatibilidade. Para eventos que participam de indicadores profissionais ou financeiros, o payload precisa seguir um envelope comum:

```ts
type CommercialEvidenceEvent = {
  eventName: string;
  aggregateType: "capture" | "opportunity" | "proposal" | "contract" | "installment" | "commission" | "cancellation";
  aggregateId: string;
  occurredAt: string;
  actorUserId: number | null;
  commercialContext: {
    customerId?: number;
    campaignId?: number;
    resortId?: number;
    salesRoom?: string;
    salesTable?: string;
    roleAttributions?: Array<{ userId: number; role: string; weight?: number }>;
  };
  policyVersionId?: number;
  evidence: Array<{ kind: "document" | "payment" | "approval" | "transcript" | "system"; ref: string; hash?: string }>;
  approval?: { status: "not_required" | "pending" | "approved" | "rejected"; actorUserId?: number; at?: string };
};
```

O modelo não obriga todos os eventos antigos a carregarem todos os campos. Ele permite enriquecer progressivamente os eventos críticos sem reescrever a história, mantendo compatibilidade com a auditoria atual.

## TGR Sales Academy: integração certa, não acoplamento burro

A Academy deve receber apenas identificadores pseudonimizados e contexto mínimo de papel/trilha, mantendo áudios e transcrições com consentimento, retenção e controle de acesso próprios. Ela devolve ao TGR sinais pedagógicos, não vereditos de emprego:

| Evento Academy → TGR | Uso permitido no CRM | Uso proibido |
| --- | --- | --- |
| Trilha concluída | Sugerir coaching, acompanhar evolução e correlacionar com resultados futuros | Inferir competência definitiva sem amostra |
| Role play avaliado | Recomendar conteúdo/mentoria com explicação | Descontar comissão ou punir automaticamente |
| Padrão de objeção recorrente | Calor de objeção agregado por equipe | Expor transcrição individual sem permissão |
| Correlação treino × venda madura | Medir hipótese de eficácia pedagógica | Declarar causalidade sem experimento e maturação |

## Laboratório seguro antes da base real

O laboratório de aceitação deve criar um conjunto isolado de casos descartáveis, cada qual com rastro completo: casal válido, possível duplicidade, entrada prevista/paga, desconto dentro/fora de alçada, comissão prevista/liberada/em risco, distrato aprovado, coorte inadimplente e sucessão de carteira. O objetivo é provar fórmulas, alertas, permissões e drill-down; **não é simular performance humana como verdade de negócio**.

## Referências

[1]: [Wave Research — scorecards, alertas e modelo mestre de eventos](/home/ubuntu/upload/WaveResearch—TGR-CRMSistemaNervosodaMultipropriedade.md)

[2]: [Schema transacional existente do TGR-CRM](/home/ubuntu/tse-crm-exclusivo/drizzle/schema.ts)

[3]: [PRD TGR Sales Academy](/home/ubuntu/upload/TGR-PRD-Manus-Handoff(1))
