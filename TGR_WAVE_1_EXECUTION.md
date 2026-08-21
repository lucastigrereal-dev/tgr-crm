# TGR-CRM — Wave 1: verdade econômica e desempenho profissional

## Objetivo

Fazer cada venda ter uma leitura única e auditável de valor, caixa, comissão, risco e qualidade; depois projetar isso em scorecards por pessoa e alertas acionáveis.

| Corte | Entrega verificável | Backend/dados | Interface | Prova |
| --- | --- | --- | --- | --- |
| W1.1 | Ledger de qualidade de receita | Migração para fatos derivados, versão de política e atribuição comercial | Ainda sem tela nova; contrato de leitura tRPC | Teste de VGV bruto, caixa, risco, distrato e reversão sem apagar fato anterior |
| W1.2 | Borderô transparente por venda e profissional | Projeção de comissão prevista, confirmada, em risco, liberada e estornada | Bloco de previsão dentro de Comissões e ficha de contrato | Teste de regras, filtros, FTB exclusivo e trilha de origem |
| W1.3 | Scorecards por papel comercial | Métricas agregadas com população, coorte, janela de maturação e definição-versionada | Painel de scorecard individual e gerencial | Teste de não dupla contagem e “amostra insuficiente” |
| W1.4 | Alertas de integridade com caso e rota | Casos de exceção, evidência, responsável, SLA e decisão | Fila de integridade na Torre e detalhes por alerta | Teste de comissão sem lastro, desconto sem aprovação e documento pendente |
| W1.5 | Laboratório isolado de operação | Fixtures descartáveis de casal, contrato, pagamento, comissão, distrato e duplicidade | Roteiro de homologação somente | E2E isolado que confirma painéis e estado persistido |

## Ordem técnica

1. **W1.1 primeiro.** Sem base econômica derivada, scorecard e alerta viram maquiagem estatística.
2. **W1.2 e W1.3 em seguida.** O profissional enxerga o próprio borderô e o gestor enxerga qualidade sem precisar caçar relatório.
3. **W1.4 depois.** Alerta deve nascer com contexto já calculado, não virar uma coleção de `if` espalhado nos roteadores.
4. **W1.5 fecha a onda.** Dados fictícios nunca entram no ambiente operacional; o laboratório é isolado, limpo e repetível.

## Fora da Wave 1

- TGR Sales Academy, voz, FSRS e gamificação: produto complementar, entra após a verdade operacional permitir correlação séria de treino e resultado.
- Score preditivo por IA: só após coortes maduras, dados consentidos e avaliação de viés; nesta onda há regras explicáveis, não caixa-preta.
- Gateway Asaas, assinatura digital e realtime estrito: continuam bloqueados por credencial/infraestrutura aprovada, sem simulação enganosa.
