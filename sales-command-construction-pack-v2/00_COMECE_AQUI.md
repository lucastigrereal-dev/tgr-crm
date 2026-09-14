# TGR Sales Command | Construction Pack V2
**Data:** 14/09/2026. **Tipo:** pacote de construção, não release de produção.

## Para Lucas e Manu
Este é o pacote único de trabalho. Substitui a especificação ativa MANUZI_READY de 14/09. A versão antiga continua intacta fora deste pacote e seu hash está no inventário de origem.

O produto acompanha a operação comercial e mostra quem precisa de ajuda, por quê e qual ação foi tomada. Não é TGR CRM, TGR Consulting nem uma nova versão automática de Sala de Guerra.

## O que já vem executável
`reference-implementation/`: regras TypeScript de valores, conversão, resultado de atendimento, exposição, atenção, concentração, permissão de referência e feedback versionado. JavaScript compilado e testes Node acompanham o código. Não precisa instalar dependência para executar `node --test tests/*.test.mjs` nessa pasta.

`ui/DEMO_LOCAL.html`: referência navegável local com dados fictícios. Não possui login real, servidor, banco compartilhado ou pagamentos. NÃO é a aplicação pronta.

`fixtures/`: dados sintéticos de 90 dias e pequeno cenário de referência, com gerador reproduzível.

## O que é contrato de construção
`contracts/`: JSON Schema, OpenAPI, regras, eventos, permissões, catálogo de indicadores.
`adapters/`: DDL MySQL e drafts Drizzle/Zod/tRPC. Draft significa código que ainda precisa de validação com as dependências e banco da aplicação. Não representa migration homologada.
`docs/`: PRD, arquitetura, produto, UI/UX, segurança, operação, 30 ideias e decisões.
`tests/`: aceite, casos-limite e roteiro de teste multiusuário. Os cenários do aplicativo NÃO foram executados nesta entrega.
`ops/`: ambiente de teste, CI de referência, observabilidade e recuperação.
`audit/`: resultados reais dos checks do pacote e limites da validação.

## Ordem que economiza contexto
1. Ler este arquivo e `MANUZI_MASTER_PROMPT.md`.
2. Ler `docs/01_PRD.md`, `docs/02_DOMAIN_RULES.md`, `docs/03_ARCHITECTURE.md`.
3. Executar `node --test tests/*.test.mjs` dentro de `reference-implementation`.
4. Executar `python scripts/verify_pack.py` na raiz, se Python, jsonschema e PyYAML estiverem disponíveis.
5. Seguir `docs/20_IMPLEMENTATION_PLAN.md`. Ler somente os arquivos da wave atual, não o acervo inteiro a cada tarefa.
6. Abrir `ui/DEMO_LOCAL.html` para entender o comportamento visual de referência.

## Regras que não podem se perder
- Pessoa/casal pode retornar: identidade única, atendimentos separados.
- NT significa atendimento que não iniciou apresentação; não criar tour fictício.
- Q/NQ é qualificação, não resultado de venda. Não apagar exposição após reclassificação.
- Uma venda comercial pode conter várias cotas. Conversão usa vendas por atendimento, não cotas.
- Entrada negociada não é entrada recebida. Sem conciliação, dinheiro recebido fica desconhecido.
- Falta/folga/treinamento e baixa exposição não são baixo desempenho.
- R$4.500 é alvo relatado por Lucas. Vigência, base por cota/venda e aprovação precisam estar explícitas.
- Números de fontes históricas não ativam política de Natal.
- Nenhuma regra aciona punição, demissão, pagamento ou desconto automaticamente.

## Definition of Done do pacote, não do produto
Documentação consistente, contratos presentes, funções de referência testadas, fixtures validadas, inventário e hashes verificáveis. O produto só passa a piloto após os gates de `docs/23_PILOT_GATES.md`.

## Atalho para o dono
Leia `GUIA_LUCAS.md`. A conferência desta entrega está em `audit/VERIFICATION_REPORT.md`. O índice real de arquivos está em `FILE_INDEX.md`; integridade em `MANIFEST.json`.