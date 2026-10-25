# Contas de teste por papel (M-A12-03)

Estado: documento + ferramenta existente (`scripts/pilot-users.mjs`). SEM CI DO GITHUB. Nada aqui cria conta real nem toca banco real.

## Papéis do CRM e onde cada pessoa da sala entra

| Pessoa na bateria | Onde entra | Papel no CRM | Observação |
|---|---|---|---|
| Recepção | Sales Command | sem login no CRM | Localiza/cadastra/confere/check-in; não vincula código nem reprocessa tempos (decisão 25/10) |
| Consultor (liner) / fechador (closer) | Sales Command | `seller` quando precisa ler contrato | Sem baixa, sem auditoria |
| Gerente de sala | Sales Command + CRM | `seller` (gerente de vendas) | Ação `capture.couple_code.link` (admin + seller) |
| Administrativo | CRM | `admin` | Único que confere comprovante, valida venda e baixa |
| Financeiro | CRM | `finance` | Baixa de parcela; não valida venda |
| Pós-vendas | Relationship | `service` | Resgate antes do distrato |

## Como gerar contas sintéticas (ambiente descartável)

```
node scripts/pilot-users.mjs --out <pasta-fora-do-repo> \
  --user qa.admin:admin:"QA Administrativo" --user qa.fin:finance:"QA Financeiro" \
  --user qa.gerente:seller:"QA Gerente de sala" --user qa.pos:service:"QA Pos-vendas"
```

- Cada conta recebe senha própria e aleatória, gravada só em `crm-credentials.local.txt` (modo 600, fora do Git). Nenhum teste compartilha senha nem usa o admin geral.
- O script recusa `--out` dentro do repositório. As contas reais ficam com o Lucas (mesmo script, nomes reais).
- Cada conta entra só com o próprio login; a prova de que cada papel só alcança o que lhe cabe é a matriz de capacidades (`server/rbacCaptureMatrix.test.ts`).

# Fixtures da bateria no CRM (M-QA-05)

Só preparo, só em banco descartável e dados sintéticos. Cadastro do casal, check-in, resultado e venda ficam para a interface (nada de venda por fixture).

```
DATABASE_URL=<banco descartável> node scripts/pilot-seed-sala.mjs --project-name "QA <RUN_ID>" --units 60 --quotas 52
```

- Cria o empreendimento com o nome do projeto do Sales, 60 UH sintéticas (SYN-UH-xx) × 52 cotas disponíveis e a política `sale_terms` do QA. Rodar de novo não duplica (teste `server/pilotSeedSala.mysql.test.ts`).
- RUN_ID no nome do projeto marca o lote como QA; o consentimento QA (marcado) e os meios de pagamento sintéticos (pix, boleto) ficam fora deste script: o consentimento nasce no GuestPass, e os meios entram na baixa da parcela.
- Contas por papel: seção acima.

Aviso: `pilot-seed-sala.mjs` não tem trava de banco isolado (também semeia o piloto de propósito). A rodada de 60 × 52 com nome "QA ..." só roda em banco descartável; nunca aponte `DATABASE_URL` para o banco do piloto ou de produção.
