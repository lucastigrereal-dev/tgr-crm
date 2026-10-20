# Etapa 2, PR D1: indicadores oficiais do CRM (provisório)

- Aproveitamento = vendas validadas / atendimentos. Eficiência = cotas vendidas por 100 atendimentos.
- Numerador só do CRM: `sale_validations.validatedAt` no período, contrato não cancelado. Oportunidade `won` marcada à mão NÃO conta. Cota = fração `sold` do contrato (mínimo 1 por venda).
- Denominador (padrão provisório): casal com check-in da recepção no período e desfecho registrado (resultado comercial, não tour ou ficha encerrada). Em andamento fica fora e é exposto em `denominator.inProgressExcluded`.
- Configurável só por admin (tela/API `officialIndicators.setConfig`, chave `official_indicators_include_in_progress` em `capture_sheet_settings`, com trilha em auditoria). Marcado `provisional: true` e `definitionVersion: provisorio-1`.
- Leitura: admin e financeiro (`officialIndicators.get`). `closeRate`/`wins` do dashboard de sala continuam como indicador de sala, NÃO oficial.
- Sem migration, sem evento, sem contrato novo. Dados de teste SYN-.
