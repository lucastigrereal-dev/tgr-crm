# Notas de Descobertas — TSE / Time Share Soluções

## Fontes analisadas
1. APK do TSE - Marketing (com.tsexplorerapp.tsemarketing, v6.0.4, Flutter) — baixado de apkcombo.com
2. DLLs do TSEExplorerWin (Windows desktop, .NET 4.8) — zip enviado pelo usuário
3. Relatório TCC IF Goiano (Lucas Inocencio Pires, 2023) — https://repositorio.ifgoiano.edu.br/bitstream/prefix/4206/1/Relat%C3%B3rio%20de%20pr%C3%A1tica%20profissional%20-%20Lucas%20Inocencio-merged.pdf
4. Site oficial: https://timesharesolucoes.com.br/ | Sistema web: https://tse.aviva.com.br/
5. Códigos TypeScript do usuário (sistema atual, Next.js + Supabase): lib-comissoes.ts, lib-cancelamento.ts, lib-bordero.ts, lib-followups.ts, lib-mensagens.ts, lib-datasComissao.ts, lib-storage.ts, lib-supabase-clients.ts, lib-format.ts, tailwind.config.ts

## Descobertas do APK (Flutter)
- Tech: Flutter (libflutter.so, libapp.so), API em .NET (endpoints PascalCase)
- Infra Firebase: domínio tse-captacao.appspot.com (Firebase), analytics + Crashlytics
- Endpoints API mapeados (namespace tss_marketing_v2):
  - /api/operadorsistema/GetByLogin/ (autenticação)
  - /api/OperadorSistema/GetListaEmpresaPermitidas, GetListaUnidadesNegocioPermitidas
  - /api/OperadorSistema/SetEmpresaSel/, SetUnidadeNegocioSel/
  - /api/Lookup/Profissoes, Ufs, Paises, CidadesComAssociacoes, TiposRelacionamento, BandeiraCartao, ModeloVeiculos, LocaisCaptacao?filtrarTenant=true, LocaisHospedagem2, LimparCache
  - /api/Captacao/MeusConvidados, MeusConvidados2 (com query ?data=)
  - /api/Captacao/GetRankingCaptacao?dataInicial= (ranking gamificação)
  - /api/captacao/abordagem/0 (fluxo de abordagem)
  - /api/TseUtils/SendSms2 (envio SMS)
- Descrição app: "Captação de casais mais rápida", "Trabalhe offline", "Agendamento e controle de convidados", "Localização dos promotores em tempo real"
- Descrição: "TSE-Marketing disponível apenas para usuários que compraram o TsExplorer"

## Descobertas das DLLs (TSEExplorerWin, .NET 4.8)
- Stack: .NET Framework 4.8 + WCF/SOAP + WebServices, NHibernate (ORM), Npgsql (PostgreSQL!), Ninject (DI), DevExpress (skin/UI), PDFSharp+Spire (relatórios), OWIN
- Arquitetura DDD: Tss.Tse.Dominio / Dal.Interfaces / Dal.Implementation / Services / Client / View.Win / View.Web
- Integrações SOAP: NEA EBA (cartões/verificação), BCB (WSSGS Bachan), Opera PMS (Reservation/Availability/Name), PortalVendas (WS)
- Entidades/entidades vistas: Contrato, Cota, Lead/Atendimento, Comissao (LancamentoComissao), UnidadeNegocio, Pessoa, Endereco, OperadorSistema, Funcionario, MetasUnidadeNegocio, MotivoCancelamento, VGV, ContaFinanceira, CartaCredito, UtilizacaoContrato, ConversaoContrato, NotaFiscal, RCI (ListarRCIProducts, intercâmbio)
- Módulos: captação/recepção, vendas, pós-vendas, gestão financeira, cobrança, mensageria, mapa de disponibilidade, controle de utilização, intercâmbio, assinatura eletrônica (AssineOnline/DocuSign), email SendGrid, pipelines Azure DevOps, autenticação JWT
- Relatório TCC: 15 módulos; empresa em Caldas Novas, 20 funcionários, clientes em Brasil + Uruguai + Paraguai

## Sistema atual do usuário (TypeScript + Supabase)
- Comissões: papéis linear 1,91% / fechador 1,51% / ftb 3,42%; base = valor_total - entrada_corretagem; liberação proporcional por parcela da entrada
- Status parcela: prevista|aguardando_pagamento_cliente|em_fechamento|aguardando_janela_cancelamento|a_receber|recebida|cancelada_nao_paga|atrasada
- Regras de datas: fechamento fim do mês da compensação (crédito = mês seguinte); janela cancelamento dia 7 do mês seguinte; pagamento dia 25 do mês seguinte
- Borderô: agrupamento mensal previsto/aReceber/recebido/travado/cancelado/atrasado
- Follow-ups: régua D+1/3/7/15/30, dupla (comprou / nao_comprou), tipos pos_venda|recuperacao|novidade|indicacao|reativacao
- Mensagens: templates personalizados {nome}, mapa de objeção (preço, reclame_aqui, desconfiança, precisa_pensar, consultar, ja_tenho)
- Storage: buckets fichas|propostas|comprovantes|brindes|audios com paths {userId}/{atendimentoId}/
- Formatação: BRL, CPF, telefone, datas com date-fns
- Frontend: Next.js App Router + Tailwind + Supabase SSR (client/server/middleware)

## Melhorias identificadas vs TSE
- TSE: app Flutter depende de lookups constantes; desktop .NET legado; sem régua WhatsApp nativa; integração PMS via SOAP
- Sistema usuário já tem: lógica de comissão moderna, régua de follow-up, templates de WhatsApp
- O que falta para ser "superior": offline-first real (Sync), ERP de frações/estoque, portal cliente, assinatura digital nativa, gateway Pix, mapa disponibilidade, ranking gamificado, RCI intercâmbio, dashboard tempo real (websockets)

## Arquivos gerados
- /home/ubuntu/tse_projeto/arquitetura_sistema_superior.mmd + .png
- /home/ubuntu/tse_projeto/modelo_dados.mmd
- Relatório final: (a criar) consolidado com ER, arquitetura, comparativo e roadmap MVP
