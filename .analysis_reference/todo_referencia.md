# Project TODO

- [x] Definir a direção visual do painel operacional antes da implementação das telas finais — Command Center Premium
- [ ] Configurar identidade visual, tipografia, tokens de cor e componentes de navegação do dashboard
- [ ] Modelar o schema multi-tenant de empresas, unidades de negócio, operadores e perfis
- [ ] Implementar isolamento de dados por empresa e unidade de negócio nas consultas e mutações
- [ ] Implementar cadastro de casal com ficha de captação: nome, CPF, telefone, profissão, veículo e local
- [ ] Implementar locais de captação e emissão de voucher de brinde
- [ ] Implementar agendamento de tour e status do atendimento: abordado, agendado, atendido, comprou e não comprou
- [ ] Implementar painel da recepção com fila de atendimentos atualizada em tempo real
- [ ] Implementar cadastro de proposta: valor total, entrada, parcelas, forma de pagamento e equipe comercial
- [ ] Reaproveitar as regras de comissão fixas: linear 1,91%, fechador 1,51% e FTB 3,42%
- [ ] Implementar cálculo server-side de liberação proporcional da comissão por parcela da entrada
- [ ] Implementar ciclo server-side de comissões e datas críticas: fechamento, janela de cancelamento dia 7 e pagamento dia 25
- [ ] Implementar borderô mensal por operador com previsto, a receber, recebido, travado, cancelado e atrasado
- [ ] Implementar geração de follow-ups D+1, D+3, D+7, D+15 e D+30 para compra e não compra
- [ ] Implementar templates de WhatsApp personalizados por nome e objeção
- [ ] Implementar dashboard executivo com VGV, conversão, ranking de captação e resumo de comissões
- [ ] Criar testes Vitest para as regras de comissão, cancelamento, borderô e follow-up
- [ ] Validar responsividade, acessibilidade, estados vazios e acabamento visual do MVP
