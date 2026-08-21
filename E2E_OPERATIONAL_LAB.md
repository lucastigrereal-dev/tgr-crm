# Laboratório operacional isolado — TGR-CRM

## Objetivo

Validar a cadeia completa de operação e inteligência sem inserir dados artificiais no banco compartilhado. O laboratório é descartável, tem credenciais próprias e deve terminar sem registros residuais.

## Travas obrigatórias

| Trava | Regra |
| --- | --- |
| Banco | O processo só inicia com `E2E_DATABASE_URL` presente e diferente de `DATABASE_URL`. |
| Identidade | Todo registro do laboratório recebe prefixo `E2E-TGR-` e `createdBy` de usuário técnico efêmero. |
| Ambiente | Nunca executar apontando para domínio publicado, banco compartilhado ou conta de operação. |
| Limpeza | O script encerra removendo a base/namespace isolado; falha de limpeza vira erro do job. |
| Evidência | Cada cenário produz log de IDs e asserts de leitura, sem exportar PII nem arquivos de produção. |

## Cenários mínimos

| Cenário | Casal descartável | Fatos que precisam existir | Leitura esperada |
| --- | --- | --- | --- |
| Captação e sala | E2E-TGR-CASAL-01 | Fila → chegada → mesa → liner/fechador → tour encerrado | Registro sai da fila ativa e conserva trilha de papéis/tempo |
| FTB justo | E2E-TGR-CASAL-02 | Promotor distinto; mesma pessoa como liner e fechador; contrato, entrada paga e comissão | Scorecard dá crédito ao promotor e um único crédito FTB |
| Comissão em risco | E2E-TGR-CASAL-03 | Contrato, parcela-fonte aberta/renegociada e comissão pendente/aprovada | Torre mostra alerta financeiro com evidência de falta de lastro |
| Distrato auditável | E2E-TGR-CASAL-04 | Parcela paga e aberta, comissão paga e reversível, pedido aprovado | Execução única preserva pagos, cancela reversíveis e cria retenção/reembolso previstos |
| Qualidade de receita | E2E-TGR-CASAL-05 | Contrato formalizado, entrada paga, saldo aberto, eventual distrato | Ledger separa VGV, caixa, exposição, reversão e comissão sem apagar fatos |
| Duplicidade segura | E2E-TGR-CASAL-06 | Nome/telefone propositalmente semelhantes, sem merge automático | Caso aparece como revisão humana, nunca como fusão silenciosa |

## Roteiro de validação

1. Validar isolamento por `scripts/check-e2e-isolation.mjs`.
2. Aplicar migrações no banco efêmero e rodar `scripts/seed-e2e-isolated.mjs` somente com prefixo permitido.
3. Executar os cenários de navegação Playwright e asserts tRPC/DB para persistência.
4. Confirmar a leitura em Sala de Vendas, Contratos, Central de Comissões, Torre de Comando e Financeiro.
5. Rodar limpeza e exigir contagem zero de registros `E2E-TGR-`.

## Condição atual

O projeto já tem scripts e E2Es estritos, mas esta sessão não dispõe de `E2E_DATABASE_URL`. Portanto, este protocolo está pronto para execução, porém **nenhum seed será disparado até haver banco descartável isolado**. Isso é uma decisão de segurança, não pendência esquecida.
