# Validação visual do borderô executivo

Em 20 de agosto de 2026, a Central de Comissões foi conferida na rota `/comissoes`. O filtro de campanha e o seletor de mês de fechamento aparecem no topo do painel; os cartões de venda, comissão, recebido, travado, a receber e cancelado permanecem coerentes no recorte selecionado.

No ambiente sem lançamentos reais, os valores foram mostrados como R$ 0,00 e os estados vazios foram explícitos. Nenhum dado demonstrativo foi criado. Uma primeira captura em `/commissions` retornou 404 por usar a rota em inglês inexistente; a rota registrada no aplicativo é `/comissoes` e foi validada com sucesso.
