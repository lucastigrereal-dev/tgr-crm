# Importação CSV — TSE Exclusivo

## Regras gerais

Use arquivos CSV UTF-8, com cabeçalho na primeira linha. O sistema aceita separador por vírgula ou ponto e vírgula e entende campos entre aspas. A importação primeiro faz uma **prévia**: nenhuma linha é gravada enquanto existirem erros de validação.

O sistema identifica associados por `documento` normalizado. Se o documento já existir, a linha de associado atualiza os dados cadastrais; contratos exigem que o associado já exista na base ou esteja no CSV de associados importado antes.

## Modelo: Associados

| Coluna | Obrigatória | Exemplo | Regra |
|---|---:|---|---|
| nome_completo | Sim | Ana da Silva | Mínimo de 3 caracteres. |
| documento | Sim | 12345678900 | Identificador do associado. |
| email | Não | ana@email.com | E-mail válido quando preenchido. |
| telefone | Não | 17999999999 | Livre. |
| data_nascimento | Não | 1985-07-25 | Formato AAAA-MM-DD. |
| estado_civil | Não | Casada | Livre. |
| profissao | Não | Empresária | Livre. |
| cep | Não | 15400000 | Livre. |
| endereco | Não | Rua das Flores | Livre. |
| numero | Não | 102 | Livre. |
| complemento | Não | Apto 11 | Livre. |
| bairro | Não | Centro | Livre. |
| cidade | Não | Olímpia | Livre. |
| uf | Não | SP | Duas letras. |
| origem | Não | Indicação | Livre. |
| status | Não | ativo | `prospect`, `ativo` ou `inativo`. |
| observacoes | Não | Cliente prefere contato WhatsApp | Livre. |

## Modelo: Contratos

| Coluna | Obrigatória | Exemplo | Regra |
|---|---:|---|---|
| numero_contrato | Sim | TS-2026-0001 | Único no sistema. |
| documento_associado | Sim | 12345678900 | Deve apontar para associado existente. |
| modelo_uso | Sim | semana_fixa | `semana_fixa`, `semana_flexivel` ou `pontos`. |
| status | Não | ativo | `rascunho`, `pendente_assinatura`, `ativo`, `inadimplente`, `cancelado` ou `encerrado`. |
| valor_total | Sim | 12500.00 | Aceita `12500,00` ou `12500.00`. |
| quantidade_parcelas | Sim | 12 | Inteiro entre 1 e 360. |
| primeiro_vencimento | Sim | 2026-09-10 | Formato AAAA-MM-DD. |
| email_vendedor | Não | vendedor@empresa.com | Quando existir, vincula o vendedor interno correspondente. |
| observacoes | Não | Entrada paga no ato | Livre. |

> A importação de contrato gera todas as parcelas automaticamente, preservando o total em centavos. Registros com erro não são parcialmente gravados.
