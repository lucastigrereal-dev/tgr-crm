# Engenharia Reversa do TSE e Arquitetura do Sistema Superior

**Autor:** Manus AI | **Data:** 17 de agosto de 2026

---

## 1. Sumário Executivo

Este documento consolida o resultado de um trabalho de **engenharia reversa e auditoria técnica** sobre o sistema **TSE (TSExplorer / Time Share Soluções)**, o principal concorrente de referência no mercado brasileiro de multipropriedade e frações, e o cruza com o código do **sistema atual construído em TypeScript sobre Supabase** (comissões, borderô, cancelamento, follow-ups e mensagens). O objetivo é entregar um plano técnico completo — arquitetura, modelo de dados e roteiro de evolução — para construir uma plataforma que não apenas clone a inteligência do TSE, mas a **supere em velocidade, experiência do captador e modernidade de infraestrutura**.

A conclusão central é a seguinte: o TSE é um sistema **moderno por fora, mas legado por dentro**. O front mobile é feito em Flutter, porém o backend desktop roda sobre **.NET Framework 4.8 com integrações SOAP** e o banco de dados é PostgreSQL gerenciado por um ORM desatualizado (NHibernate). O seu sistema atual, por outro lado, já possui uma **lógica de negócio mais madura em pontos críticos** (cálculo de comissões com liberação proporcional por parcela, máquina de estados de cancelamento com janela de 7 dias, régua de follow-up com templates de WhatsApp) — exatamente os pontos onde o TSE tradicionalmente trava a operação. A oportunidade é transformar essa lógica já excelente em um produto completo de ERP de multipropriedade.

| Dimensão | TSE (legado) | Seu sistema atual | Sistema Superior (meta) |
|---|---|---|---|
| Stack backend | .NET Framework 4.8 + SOAP + NHibernate | Next.js + Supabase (PostgreSQL + Edge Functions) | Next.js/Node + PostgreSQL + filas assíncronas |
| Front mobile | Flutter (v2) | Não identificado nos arquivos | React Native (offline-first) |
| Front web | Desktop WinForms / Web antigo | Next.js App Router + Tailwind | Same + portal do multiproprietário |
| Comissões | LançamentoComissao rígido | Liberação proporcional por parcela + borderô | Idem + split em cascata multi-nível configurável |
| Follow-up | Mensageria via SendGrid (e-mail) | Régua WhatsApp D+1/3/7/15/30 | Idem + IA de agendamento e resposta |
| Banco | PostgreSQL + NHibernate | Supabase | PostgreSQL (supabase ou self-hosted) |
| Captação | Lookups síncronos, online | Fichas no storage | **Offline-first com sync automático** |

---

## 2. O que o TSE é (Raio-X Técnico)

### 2.1 Panorama da empresa e do produto

A Time Share Soluções, sediada em Caldas Novas (GO), comercializa o **TSExplorer** como a solução "mais completa do Brasil" para timeshare e frações, atuando em todo o território nacional e em clientes do exterior (Uruguai e Paraguai). Segundo o relatório técnico do IF Goiano, o TSExplorer possui **15 módulos** que cobrem a jornada completa: captação/recepção, vendas, pós-vendas, gestão financeira, cobrança e mensageria, além de mapa de disponibilidade de frações, controle de utilização e intercâmbio entre sistemas (RCI) [1]. O sistema tem duas caras: o **desktop TSExplorerWin** (usado pelo backoffice e sala de vendas) e o **app mobile TSE Marketing** (usado pelos promotores de captação), sendo o app disponível apenas para clientes que compraram o TSExplorer.

### 2.2 Stack tecnológica revelada pela engenharia reversa

A análise dos binários (APK Android v6.0.4 e pacote de DLLs do TSExplorerWin) revelou a seguinte arquitetura:

| Camada | Tecnologia identificada | Evidência |
|---|---|---|
| App mobile | Flutter (libflutter.so, libapp.so) | APK com `libflutter.so`; namespace interno `tss_marketing_v2` |
| Backend desktop | .NET Framework 4.8 + WCF/SOAP + ASP.NET MVC | `TSEExplorerWin.exe.config`, `System.Web.Mvc` |
| ORM / DAL | NHibernate 4.1 + Npgsql (PostgreSQL) | Binding redirects no config + `Npgsql.dll` |
| DI / Log | Ninject 3.3, NLog | DLLs do pacote |
| Relatórios | DevExpress + PDFSharp + Spire.Pdf | DLLs de skin e PDF |
| Infra cloud do mobile | Firebase (App Engine / appspot) | `tse-captacao.appspot.com`, Analytics, Crashlytics |
| Assinatura digital | AssineOnline + DocuSign | Relatório IF Goiano, seção 2.3.2.2 |
| E-mail transacional | SendGrid (JWT + REST) | Relatório IF Goiano, seção 2.3.2.1 |
| Gateway | SOAP com NEA EBA (cartões), BCB (WSSGS), Opera PMS | `TSEExplorerWin.exe.config`, endpoints SOAP |

A infraestrutura do mobile deles roda sob o projeto Firebase **`tse-captacao`**, com API REST no padrão `/api/{modulo}/{acao}`. A presença de `MSAL` no cache indica autenticação corporativa Microsoft em partes do sistema.

### 2.3 Endpoints mapeados do TSE Marketing (app dos captadores)

O APK revelou a estrutura exata da API de captação, que organiza os módulos em três grandes blocos: **OperadorSistema** (autenticação e contexto multi-tenant), **Lookup** (dados mestres) e **Captacao** (o core da rua).

| Bloco | Endpoints revelados | Função de negócio |
|---|---|---|
| OperadorSistema | `/api/operadorsistema/GetByLogin/`, `GetListaEmpresaPermitidas`, `GetListaUnidadesNegocioPermitidas`, `SetEmpresaSel/`, `SetUnidadeNegocioSel/` | Login do promotor, seleção de empresa/unidade de negócio (multi-tenant) |
| Lookup | `/api/Lookup/Profissoes`, `Ufs`, `Paises`, `CidadesComAssociacoes`, `TiposRelacionamento`, `BandeirasCartao`, `ModeloVeiculos`, `LocaisCaptacao?filtrarTenant=true`, `LocaisHospedagem2`, `LimparCache` | Fichas de qualificação — inclusive **modelo do veículo** (proxy de renda) e local de captação |
| Captacao | `/api/Captacao/MeusConvidados`, `/api/Captacao/GetRankingCaptacao?dataInicial=`, `/api/captacao/abordagem/0` | Gestão de convidados, ranking gamificado, fluxo de abordagem |
| Utilitários | `/api/TseUtils/SendSms2` | Notificação por SMS |

Três insights estratégicos emergem desse mapeamento. Primeiro, o app **filtra convidados por data** (`MeusConvidados?data=`), indicando que toda consulta é síncrona e online — qualquer falha de sinal na rua trava a operação do promotor. Segundo, existe um módulo de **ranking de captação** (gamificação), algo que motiva as equipes de captação. Terceiro, a qualificação do casal inclui **modelo de veículo e profissão**, usados como proxy de renda e perfil de consumo antes da abordagem.

### 2.4 Entidades de negócio do TSExplorer (DLL de Domínio)

A DLL `Tss.Tse.Dominio.dll` (5,7 MB) é o coração do modelo de dados deles. As strings revelam entidades com métodos complexos que entregam o "dicionário de negócio" do sistema:

| Entidade | Sinais encontrados na DLL | Regra de negócio embutida |
|---|---|---|
| Contrato | `ListaStatusContratoPossiveis`, `StatusContratoPassivelReajusteMonetario`, `VGVContratosNaoCanceladosNoPeriodoPercentual`, `IdPessoaComprador` | Status do contrato, reajuste monetário, VGV (valor geral de vendas), vinculação ao comprador |
| Cota (fração) | `ListaStatusValidosNaoVendidosCota`, `ListaStatusValidosCota`, `ListaStatusPossiveisCota` | Ciclo de vida da fração (disponível, vendida, em negociação) |
| Comissão | `LancamentosComissaoMarcadosComoPago`, `TipoValorCalculoComissaoBind`, `ValorFuturoComissoesEmContratosCancelados`, `ValorFuturoComissoesEmContratosInadimplentes` | Cálculo por tipo de valor, reversão quando contrato cancela ou inadimplente |
| Financeiro | `LancamentosEntradaValidos`, `QuantidadeCobranca`, `ValorTotalSaldoRestantePago`, `ValorMultaEmAberto`, `ValorBrutoRetido` | Entradas, cobranças, multas, retenções |
| Pessoa / Endereço | `get_EnderecoPrincipal`, `ObterEnderecoCorrespondenciaPreferencial`, `ObterFoneResidPreferencial` | Cadastro único com múltiplos endereços e telefones |
| Unidade de Negócio | `set_ListaMetasUnidadeNegocioFuncionarios`, `MetaAtingidaLimiteCancelamentoPeriodo` | Metas por unidade e limite de cancelamento por período |
| Utilização / RCI | `RequestUtilizacaoContratoTsV2`, `ListarRCIProducts`, `frmConsUtilizacaoContrato` | Reserva das semanas, intercâmbio RCI |
| Cancelamento | `ListaCancelamentosSemMulta`, `ListaCancelamentosComMulta`, `frmConsCancelamentoContrato` | Regras de multa e reversão |

### 2.5 Fluxo completo da operação no TSE (reconstruído)

Com base nas três fontes (APK, DLLs e relatório acadêmico), o fluxo operacional do TSE é o seguinte. Na **rua**, o promotor abre o app, seleciona o local de captação (o tenant filtra os locais permitidos), registra o casal na ficha (nome, CPF, telefone, profissão, modelo do veículo, local de hospedagem) e agenda o tour. Na **sala de vendas**, o recepção confirma a chegada no TSExplorerWin desktop e direciona para uma mesa de liner/fechador. O **fechador** lança a proposta, define o valor total e a entrada, escolhe a forma de pagamento (a bandeira do cartão também é um lookup do app) e finaliza a venda. No **backoffice**, o financeiro acompanha o VGV, os contratos (com assinatura eletrônica via AssineOnline/DocuSign), as comissões dos operadores envolvidos, a cobrança das parcelas restantes e o fluxo de cancelamento com ou sem multa. Por fim, o cliente utiliza suas semanas de fração e, opcionalmente, intercambia via RCI.

---

## 3. Auditoria do Seu Sistema Atual

Os arquivos enviados (`lib-comissoes.ts`, `lib-cancelamento.ts`, `lib-bordero.ts`, `lib-datasComissao.ts`, `lib-followups.ts`, `lib-mensagens.ts`, `lib-storage.ts`, `lib-supabase-clients.ts`) revelam um sistema com **lógica de negócio de altíssima qualidade**, construído sobre Next.js + Supabase.

### 3.1 O que já é excelente

A arquitetura das **comissões** é superior à do TSE em três aspectos: o percentual é parametrizado por papel (`linear` 1,91%, `fechador` 1,51%, `ftb` 3,42%) sobre o saldo base (valor total menos entrada de corretagem); a liberação é **proporcional por parcela da entrada** — se a entrada de R$ 8.000 é paga em 4 parcelas de R$ 2.000, cada parcela libera 25% da comissão, o que elimina a discussão clássica de "vendi, cadê meu dinheiro"; e o **borderô mensal** consolida previsto, a receber, recebido, travado, cancelado e atrasado em visão executiva.

A **máquina de estados de cancelamento** é a peça mais sofisticada do sistema: uma parcela passa por `prevista → aguardando_pagamento_cliente → em_fechamento → aguardando_janela_cancelamento → a_receber → recebida`, com terminais `cancelada_nao_paga` e `atrasada`. As datas críticas seguem regra fixa e auditável: fechamento no fim do mês da compensação (crédito fecha no mês seguinte), janela de cancelamento até o dia 7 do mês seguinte e pagamento no dia 25. Essa determinística é exatamente o que o TSE esconde em código C# monolítico — no seu sistema, ela é transparente e testável.

O **módulo de follow-up** vai muito além do que o TSE oferece: enquanto eles dependem de e-mail transacional (SendGrid), o seu sistema opera régua dupla (comprou / não comprou) em D+1, D+3, D+7, D+15 e D+30, com templates personalizados via WhatsApp (`wa.me`), mapeamento de objeções (preço, Reclame Aqui, desconfiança, "preciso pensar") e tipos distintos de abordagem (pós-venda, recuperação, indicação, novidade, reativação).

O **storage** já modela o ciclo documental completo com buckets `fichas`, `propostas`, `comprovantes`, `brindes` e `audios`, com paths `{userId}/{atendimentoId}/` compatíveis com Row Level Security do Supabase.

### 3.2 O que falta para superar o TSE

| Lacuna | Por que importa | Como o sistema superior resolve |
|---|---|---|
| Offline-first na captação | Sem sinal na rua, o promotor para | SQLite local + sync de conflitos; lead é gravado local e sincroniza quando voltar o sinal |
| Módulo de frações/estoque | Não há controle de semanas disponíveis, mapa de disponibilidade ou reservas | Tabela `fraction_unit` + `reserva` + mapa de disponibilidade visual |
| Portal do multiproprietário | Cliente não tem autosserviço (boletos, 2ª via, agenda de uso) | Portal web com autenticação por contrato |
| Split de comissão em cascata multi-nível | Só há 3 papéis fixos; supervisores e recaptura não recebem | Tabela de regras configuráveis por hierarquia (ftb → supervisor → gerente → unidade) |
| Assinatura digital nativa | Propostas ainda dependem de fluxo externo | Integração Clicksign/Docusign via webhook com status no contrato |
| Gateway de pagamento com baixa automática | Compensação é informada manualmente | Integração Pix/cartão com webhook marcando `data_compensacao` (que dispara toda a cadeia de comissões) |
| Tempo real na sala de vendas | Fila de mesas e cronômetro de tour não existem | WebSockets / Supabase Realtime para fila de agendamento ao vivo |
| Gamificação além do ranking | Ranking de captação existe, mas sem metas e prêmios | Metas por período + painéis ao vivo na sala (como o TSE faz, porém melhor) |

---

## 4. Arquitetura do Sistema Superior

A arquitetura proposta mantém o que o seu sistema já tem de melhor (Supabase como banco, Next.js como frontend, TypeScript como linguagem universal entre front, back e regras de negócio) e adiciona as camadas de estoque, portal do cliente e automações. O diagrama abaixo mostra o fluxo completo entre os quatro atores da operação de multipropriedade.

![Arquitetura do Sistema Superior](https://private-us-east-1.manuscdn.com/sessionFile/SEvE6YrFD2PxqJXYE6thJS/sandbox/eIde2OHrtg6uzREPO8G6vS-images_1786974819021_na1fn_L2hvbWUvdWJ1bnR1L3RzZV9wcm9qZXRvL2FycXVpdGV0dXJhX3Npc3RlbWFfc3VwZXJpb3I.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvU0V2RTZZckZEMlB4cUpYWUU2dGhKUy9zYW5kYm94L2VJZGUyT0hydGc2dXpSRVBPOEc2dlMtaW1hZ2VzXzE3ODY5NzQ4MTkwMjFfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwzUnpaVjl3Y205cVpYUnZMMkZ5Y1hWcGRHVjBkWEpoWDNOcGMzUmxiV0ZmYzNWd1pYSnBiM0kucG5nIiwiQ29uZGl0aW9uIjp7IkRhdGVMZXNzVGhhbiI6eyJBV1M6RXBvY2hUaW1lIjoxNzg5NDMwNDAwfX19XX0_&Key-Pair-Id=K2QY5QTL8JSY6C&Signature=MEQCIDbMd2KmTP3rXkQ9qiL8NQV-EBoUlq~a5yOlRDzW4gKPAiBmC1oSBqLk26GUaxFHmbQzSkdQhb1RLGvwbksufdvnVQ__)

A arquitetura se apoia em **quatro pontos de contato**, cada um com uma interface dedicada. O **promotor** opera um app mobile com captação offline-first (ficha completa, voucher de brinde, agendamento de tour), sincronizando quando retomar o sinal. A **recepção da sala de vendas** opera um painel web com fila de agendamentos em tempo real, cronômetro de tour e passagem de mesa do liner para o fechador. O **backoffice** (financeiro, jurídico, gerência) opera o ERP completo: estoque de frações, contratos, comissões em cascata, cobrança e relatórios de VGV. O **cliente final** opera o portal do multiproprietário para ver suas semanas, gerar boletos, acompanhar reservas e intercâmbio.

O "cérebro" continua sendo o PostgreSQL via Supabase, com as regras de negócio já validadas do seu sistema (`lib-comissoes.ts`, `lib-cancelamento.ts`, `lib-datasComissao.ts`) transformadas em **funções puras server-side**, garantindo que o cálculo nunca dependa do relógio ou do navegador do usuário. As automações (réguas de follow-up, webhooks de pagamento, geração de borderô) rodam em Edge Functions e filas assíncronas, para que o pagamento de uma parcela de Pix dispare automaticamente a compensação, o recálculo do status da comissão e a régua de comunicação — sem intervenção manual.

---

## 5. Modelo de Dados (ER)

O modelo de dados abaixo é o esqueleto do sistema superior. Ele unifica o seu sistema atual (atendimentos, propostas, parcelas de comissão, follow-ups) com as entidades que o TSE revelou nas DLLs (frações, reservas, unidades de negócio, intercâmbio).

![Modelo de Dados](https://private-us-east-1.manuscdn.com/sessionFile/SEvE6YrFD2PxqJXYE6thJS/sandbox/eIde2OHrtg6uzREPO8G6vS-images_1786974819021_na1fn_L2hvbWUvdWJ1bnR1L3RzZV9wcm9qZXRvL21vZGVsb19kYWRvcw.png?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvU0V2RTZZckZEMlB4cUpYWUU2dGhKUy9zYW5kYm94L2VJZGUyT0hydGc2dXpSRVBPOEc2dlMtaW1hZ2VzXzE3ODY5NzQ4MTkwMjFfbmExZm5fTDJodmJXVXZkV0oxYm5SMUwzUnpaVjl3Y205cVpYUnZMMjF2WkdWc2IxOWtZV1J2Y3cucG5nIiwiQ29uZGl0aW9uIjp7IkRhdGVMZXNzVGhhbiI6eyJBV1M6RXBvY2hUaW1lIjoxNzg5NDMwNDAwfX19XX0_&Key-Pair-Id=K2QY5QTL8JSY6C&Signature=MEUCIQDyFTKQJKgyZsXNITAzR7Wq6CjYkHqbYnSxv8GyAdCwMwIgGjricpvjVXrw5Frdpcc9-ami~OevK0UR99ZXj6p~JTE_)

O modelo se organiza em cinco áreas. A área de **pessoas e operadores** mantém um cadastro único de clientes (`pessoa`) e uma hierarquia de operadores com papéis flexíveis (`promotor`, `linhador`, `fechador`, `ftb`, `gerente`, `admin`) vinculados a empresas e unidades de negócio no padrão multi-tenant. A área de **captação** liga atendimento a um casal, a um local de captação e a uma unidade de negócio — replicando o filtro `filtrarTenant=true` do TSE. A área de **vendas e comissões** traz a proposta com seus papéis de comissão e a tabela `parcela_comissao` com a máquina de estados já auditada (prevista, em fechamento, janela de cancelamento, a receber, recebida, cancelada, atrasada). A área de **contratos e frações** introduz o `contrato` com VGV e status, e o estoque físico (`fraction_unit`) com tipo de utilização — semana fixa, flutuante ou pontos — ligado a reservas. Por fim, a área de **automação** traz os follow-ups da régua automática, agora persistente no banco e acompanhada por status (pendente, enviado, respondido, ignorado), permitindo métricas reais de recuperação.

Um ponto de desenho merece destaque: a decisão de **persistir os status calculados** na `parcela_comissao` em vez de recalculá-los toda vez. A sua função `calcularStatusComissaoPorData` é determinística e pura — ela pode rodar como batch noturno (ou gatilho no webhook de pagamento) para materializar o status em coluna, permitindo indexação e dashboards rápidos, enquanto mantém a função pura como fonte da verdade.

---

## 6. Roteiro de Construção (Roadmap MVP → Completo)

A construção deve seguir a ordem em que o valor chega à operação. O **MVP de 4 a 6 semanas** concentra-se em digitalizar a rua: app do promotor offline (ficha + voucher + agendamento), painel da recepção com fila de agendamentos e o motor de comissões/borderô já existente migrado para servidor. O **segundo ciclo** entrega o fechamento da venda no sistema: proposta, pagamento com gateway Pix/cartão com baixa automática via webhook e contratos com assinatura digital. O **terceiro ciclo** entrega o backoffice financeiro completo: metas por unidade, ranking gamificado com metas e prêmios, cancelamento com e sem multa e relatórios de VGV. O **quarto ciclo** entrega o portal do multiproprietário, o mapa de disponibilidade de frações, reservas, intercâmbio RCI e o dashboard executivo multi-tenant.

| Ciclo | Escopo | Ganhador para a operação |
|---|---|---|
| 1 — MVP (4–6 sem) | App promotor offline, fila de recepção, motor de comissões server-side | O promotor nunca mais perde lead por falta de sinal |
| 2 — Venda digital | Proposta, gateway de pagamento com webhook, assinatura digital | Baixa automática da entrada → comissão calculada e liberada sozinha |
| 3 — Backoffice | Metas, ranking com prêmios, cancelamentos, VGV, cobrança | Gestão financeira enxuta, sem planilhas paralelas |
| 4 — ERP completo | Portal do cliente, frações e reservas, mapa de disponibilidade, RCI | O cliente se autosserviu e a operação escala sem equipe extra |

---

## 7. Considerações Finais

A engenharia reversa confirmou que o TSE é um sistema sólido em regras de negócio, mas preso a uma arquitetura de **década passada**: desktop .NET Framework 4.8, integrações SOAP, app mobile que não trabalha de verdade offline e lógica de comissão embutida em DLLs fechadas. O seu sistema atual já resolve, com código moderno e testável, justamente os dois maiores pontos de dor da operação de captação: **a liberação justa e proporcional de comissões** e **a recuperação sistemática de clientes com régua de WhatsApp**.

O caminho recomendado é não construir tudo do zero, e sim **elevar o sistema existente**: manter a lógica TypeScript que já funciona, adicionar o estoque de frações, o portal do cliente, o offline-first e o gateway de pagamentos, e publicar como plataforma multi-tenant (SaaS) — algo que o TSE não oferece, já que seu modelo é licença de software por empresa. Assim, você cria não apenas um sistema melhor para a sua operação, mas um **produto que pode ser vendido a outras salas de vendas de timeshare**, com a Time Share Soluções como principal referência comparativa.

---

## Referências

[1] Relatório de Prática Profissional — TS Explorer, IF Goiano (2023). Disponível em: [repositorio.ifgoiano.edu.br](https://repositorio.ifgoiano.edu.br/bitstream/prefix/4206/1/Relat%C3%B3rio%20de%20pr%C3%A1tica%20profissional%20-%20Lucas%20Inocencio-merged.pdf)

[2] TSE Marketing (com.tsexplorerapp.tsemarketing), APK v6.0.4, análise de strings e endpoints — fonte: APKPure/Aptoide.

[3] Site institucional Time Share Soluções: [timesharesolucoes.com.br](https://timesharesolucoes.com.br/)
