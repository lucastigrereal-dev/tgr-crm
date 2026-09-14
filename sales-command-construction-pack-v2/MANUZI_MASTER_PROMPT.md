# Mandato de construção para Manus / Manu

Você recebeu o Construction Pack V2 do TGR Sales Command. Não reinvente o produto e não reexecute a pesquisa histórica por padrão.

## Resultado esperado
Aplicação web responsiva que opera em celulares e computadores com banco compartilhado, acompanha captação e sala e transforma fatos em atenção gerencial. Deve funcionar independente do TGR CRM e integrar no futuro via API/eventos.

## Primeiro passo obrigatório
Verifique se já existe um repositório autorizado `tgr-sales-command`. Caso exista, audite e aproveite o trabalho. Caso não exista, prepare checkout local isolado com esse nome. Não crie outro CRM nem altere `tgr-crm`, `tgr-consulting` ou `tgsolutions`. Criação remota, push, merge e publicação somente quando autorizados por Lucas.

## Fonte de verdade
1. Decisões explícitas de Lucas, com escopo e vigência.
2. Este pacote V2 e suas decisões registradas.
3. Contratos em `contracts` e regras em `reference-implementation`.
4. Referências históricas identificadas, nunca valores vivos.

As mudanças V1→V2 estão em `audit/SQUAD_AUDIT_REPORT.md`. Não recuperar regra conflitante da V1 sem registrar decisão.

## Trabalho em ondas
Siga `docs/20_IMPLEMENTATION_PLAN.md`. Cada wave termina em demonstração verificável e receipt. Não pare a cada bug claro. Reproduza, escreva teste, corrija, valide, continue. Pare apenas diante de risco destrutivo, acesso não autorizado ou decisão de negócio genuinamente indispensável. Uma dependência bloqueada não interrompe módulos independentes.

## Autonomia
Pode construir e testar localmente, refatorar o necessário, melhorar acessibilidade, corrigir validações e falhas consistentes com o pacote. Não pode inventar régua financeira/comercial, publicar dados reais, copiar TSE, alterar produção, apagar dados ou criar serviços pagos. Defaults `DEMO_ONLY` nunca se tornam políticas produtivas silenciosamente.

## Critérios de engenharia
- TypeScript, mesma família React/Node/Drizzle/MySQL proposta, sem trocar stack por preferência.
- Monólito modular. Sem microsserviços, IA preditiva, gravação ou LMS novo no P0.
- Acesso autenticado e autorizado por projeto/equipe no servidor, inclusive realtime e export.
- Mutação crítica: autorização → validação → lock/versão → transação → fato + auditoria + outbox → commit → projeção.
- Núcleo entregue é reutilizável, mas não substitui autenticação/persistência do app.
- Regra econômica e indicador precisam de numerador, denominador, período, população e estado da fonte.
- Testes e migrações em banco exclusivo e descartável. Nenhum teste é autorizado a usar produção.

## Controle de créditos
Use um agente integrador. Delegue somente frentes independentes com arquivos exclusivos. Reutilize cálculos e schemas; não peça a cinco agentes que redesenhem a mesma entidade. Produza um `CONTEXT_CURRENT.md` curto ao fim de cada wave. Não carregar referências financeiras e histórico da V1 em todas as tarefas.

Modelo: usar o modelo de engenharia disponível no seu ambiente, identificado no receipt; esforço alto para dados, concorrência, autorização e regras; esforço padrão para componentes repetitivos. Não inventar nomes de modelo nem alegar configuração que não foi aplicada.

## Receipt por wave
Entregue: commit/local diff, arquivos alterados, comandos, resultados, screenshots, limitações, estados VERIFIED/NOT_RUN/BLOCKED. Nenhuma frase "funciona" sem evidência. Não chamar teste unitário de E2E do produto.

## Gate final
Lucas deve conseguir entrar no ambiente de homologação, criar um casal, registrar chegada, iniciar atendimento, simular venda, reencontrá-la após refresh e vê-la em outro computador autorizado. Também deve registrar NT sem apresentação, abrir atenção e iniciar intervenção. Só depois avaliar piloto.