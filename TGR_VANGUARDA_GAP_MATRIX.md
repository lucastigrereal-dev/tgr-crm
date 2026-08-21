# TGR-CRM — matriz de cobertura da vanguarda operacional

**Regra de leitura:** “parcial” não significa inexistente. Significa que há fundação funcional, mas ainda não existe leitura governada, regra de integridade ou prova operacional suficiente para usar aquele dado como verdade executiva.

| Pilar pesquisado | Cobertura atual verificável no TGR | Estado | Lacuna que importa | Prioridade |
| --- | --- | --- | --- | --- |
| Jornada de casal e sala | Ficha de captação, casal, campanha, chegada, mesa, liner, fechador, tour, sem-tour e estados terminais | Forte | Falta ligar produtividade de sala a qualidade financeira e maturação da venda | P0 |
| Papéis comerciais | Promotor, liner e fechador na captação; liner, closer e FTB em comissão | Parcial | Falta ledger de atribuição por papel e histórico de gerente/qualificador sem reescrever passado | P0 |
| Proposta e desconto | Propostas, valor de entrada e aprovação de desconto auditável | Parcial | Falta alçada versionada por projeto, alerta de exceção e correlação desconto × qualidade da receita | P0 |
| Contrato e documentação | Contrato, parcelas, documentos e status existem | Parcial | Falta checklist bloqueante e comparação governada entre oferta aprovada e contrato formalizado | P0 |
| Comissão e borderô | Comissão proporcional por parcela, lifecycle, calendário de fechamento e borderô já existem | Forte | Falta visão unificada de comissão prevista, confirmada, em risco, disputada e estornada por venda/pessoa | P0 |
| Distrato e impacto | Política por empreendimento, simulação congelada, aprovação, execução transacional e lançamentos previstos | Parcial | Falta prova visual em homologação e leitura de coorte para medir qualidade da venda por origem e profissional | P0 |
| Receita de qualidade | VGV, parcelas, baixas, comissão e distrato são registrados em módulos distintos | Parcial | Falta ledger analítico que materialize VGV bruto, confirmado, líquido, em risco e perdido sob a mesma chave de venda | P0 |
| Ranking profissional | Ranking de comissão e qualidade por evidência existem | Parcial | Falta scorecard equilibrado por função, coorte madura, herança de carteira e impacto de inadimplência/distrato | P0 |
| Forecast e meta | Metas, progresso de campanha, probabilidade de oportunidade e funil existem | Parcial | Faltam snapshots de pipeline, cobertura, forecast por cenário e acurácia histórica | P1 |
| Qualidade e duplicidade de dados | Deduplicação de fila offline por hash, validação CSV e relacionamento 360° existem | Parcial | Falta matching fuzzy, golden record e fila de revisão de duplicidade entre fontes | P1 |
| Equidade e capacidade de sala | Mesa, horário, sala, papéis, cronômetro e analytics são registrados | Parcial | Faltam distribuição controlada, capacidade, fairness de mesa e alerta de padrão anômalo | P1 |
| Cobrança e caixa | Parcela, régua, renegociação, conciliação e DRE por campanha existem | Forte | Falta visão de gap de caixa por venda: entrada prometida × recebida × comissão exposta | P0 |
| Alertas de integridade | Fila de exceções, auditoria e eventos de domínio existem | Parcial | Faltam regras explícitas de venda sem lastro, versão de comissão divergente, reabertura suspeita e concentração anômala | P0 |
| IA explicável | Assistente com evidência, permissão e aprovação humana existe | Fundação correta | Ainda faltam dataset maduro, features versionadas, avaliação de viés e score de risco que só recomende | P2 |
| Treinamento adaptativo | Playbooks comerciais e ranking de qualidade existem | Fundação indireta | A TGR Sales Academy deve ser produto/módulo conectado, com role play, FSRS, XP e correlação posterior, não acoplamento apressado | P2 |

## Veredito

O TGR já deixou de ser uma casca: a operação essencial está modelada e auditável. A maior oportunidade agora não é criar mais formulários; é conectar o que já existe em uma **verdade econômica por venda e por profissional**. A mesma venda precisa poder ser lida como VGV bruto, entrada prevista, entrada recebida, comissão estimada, comissão liberada, comissão em risco, inadimplência, distrato e receita líquida sobrevivente.

Essa chave econômica também resolve o ranking justo. Um captador não será premiado por ficha criada; será medido pelo comparecimento e pela qualidade downstream. Um fechador não será campeão por assinatura; será medido por conversão e maturação da carteira. E o financeiro não será o coveiro da planilha; será a fonte que confirma ou derruba a previsão comercial.

## Arquitetura que não se negocia

1. **Eventos imutáveis como evidência.** O `domain_events` já é a fundação; a próxima onda deve normalizar dimensões de contexto, evidência e versão de regra, sem apagar a auditoria existente.
2. **Read models, não relatório espaguete.** O ledger de qualidade e os scorecards devem ser projeções derivadas dos eventos, contratos, parcelas, comissões e distratos; nenhum painel crítico recalcula regra de dinheiro no navegador.
3. **Maturação explícita.** Ranking e VGV líquido devem informar janela de coorte e cobertura de dados. Venda de ontem não concorre com venda que já atravessou entrada, primeira parcela e janela de cancelamento.
4. **Alerta é pergunta com rota.** Alerta de mesa premiada, venda sem entrada ou desconto fora de alçada deve mostrar evidência, responsável, prazo e ação; não pode ser sirene decorativa.
5. **IA só recomenda.** Nenhum score futuro pode liberar comissão, aprovar distrato, classificar profissional ou agir sobre dinheiro sem evidência visível e aprovação humana.

## Referências

[1]: [Wave Research — TGR-CRM Sistema Nervoso da Multipropriedade](/home/ubuntu/upload/WaveResearch—TGR-CRMSistemaNervosodaMultipropriedade.md)

[2]: [Schema operacional atual do TGR-CRM](/home/ubuntu/tse-crm-exclusivo/drizzle/schema.ts)

[3]: [Plano de Vanguarda já consolidado](/home/ubuntu/tse-crm-exclusivo/PLANO_VANGUARDA_TGR.md)

[4]: [PRD TGR Sales Academy — produto complementar](/home/ubuntu/upload/TGR-PRD-Manus-Handoff(1))
