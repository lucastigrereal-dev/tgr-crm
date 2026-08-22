# Segmentação histórica de fichas

## Objetivo

A ficha de captação é uma fonte histórica de CRM, não apenas uma tela de cadastro. O backend preserva os dados do titular, casal, filhos, renda, carro, cartão, moradia, viagens, origem, qualificação e operação da sala na tabela `capture_records`, ligada ao cliente, à campanha, ao empreendimento e à oportunidade.

## Consulta

O procedimento interno `captures.profileAnalysis` aceita período e filtros combináveis. Os filtros estruturados incluem cidade, UF, sala, local de captação, marca/modelo/ano do veículo, quantidade mínima/máxima de filhos, renda mínima/máxima, gasto médio de hotel, semanas de viagem, cartão, cheque, casa própria, imóvel na cidade, passante, qualificação, campanha, empreendimento e status da sala.

O campo `search` faz busca textual em todos os blocos da ficha: nome, documento, contato, cidade, empreendimento, campanha, sala, origem, hospedagem, transporte, cônjuge, profissão, relacionamento, nomes dos filhos, veículo, bandeiras de cartão, época e descrição de viagens, redes sociais, brinde, motivo de qualificação e observações.

## Retorno analítico

A resposta devolve a quantidade total encontrada, amostra paginada para a interface, indicação de truncamento, completude por ficha e resumo agregado com qualificação, chegada, apresentação, ganhos, sem-tour, renda média, gasto médio de hotel, média de filhos, completude média e quantidade de perfis completos.

Também devolve distribuições por marca de carro, cidade, quantidade de filhos, qualificação e época de viagem. Cada agrupamento informa volume, quantidade qualificada e ganhos quando a dimensão possui resultado comercial.

## Segurança e desempenho

A consulta é protegida por acesso interno, utiliza intervalo de datas explícito, limita a amostra exibida a 500 registros por chamada e retorna as métricas sobre todo o recorte encontrado. Índices foram adicionados para localização, carro, campos numéricos de perfil e viagem. O texto permanece sem dados fictícios e a camada não consulta serviços externos.

## Uso operacional

A tela `/analise-de-vendas` combina os filtros operacionais da sala — período, campanha, empreendimento, sala e status — com os filtros de perfil. Assim é possível, por exemplo, analisar casais captados em determinado período, com Toyota, dois filhos ou mais, renda acima de um valor e cartão informado, observando qualificação, apresentação e conversão no mesmo recorte.
