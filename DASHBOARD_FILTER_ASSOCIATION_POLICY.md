# Política de Associação para Filtros do Dashboard

Uma oportunidade é a unidade comercial do funil e deve aparecer **uma única vez** em gráficos, exportações e drill-downs do dashboard principal.

Quando existirem várias fichas de captação vinculadas à mesma oportunidade, o recorte operacional de empreendimento, sala, papel ou status deve usar a ficha mais recente por `createdAt`. A escolha é determinística e evita multiplicar quantidade de propostas ou valor esperado.

Uma oportunidade sem ficha vinculada permanece visível em recortes gerais. Em filtros operacionais específicos, ela não entra no resultado porque não há evidência para atribuí-la a empreendimento, sala, papel ou status. Esse comportamento evita fabricar contexto operacional inexistente.
