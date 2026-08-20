# Auditoria de Integração — `tgsolutions` e TGR-CRM

## Escopo e limite de segurança

O repositório GitHub `lucastigrereal-dev/tgsolutions` foi identificado como o pacote auditado do TSExplorer. A cópia de auditoria possui aproximadamente **791 MB**, com **460 DLLs**, **3 executáveis**, **876 arquivos de log**, **46 documentos Markdown**, nenhum arquivo-fonte C# e um único commit de importação do pacote auditado.

Os documentos internos do pacote declaram que ele contém dados pessoais, financeiros, telas, logs e configurações reais. A estratégia de integração, portanto, deve ser **clean-room**: usar apenas a documentação de comportamento, requisitos conceituais e materiais anonimizados para validar lacunas; não copiar, executar, importar ou versionar binários, dados, logs, telas ou configurações do TSExplorer no TGR-CRM.

## Conclusão preliminar

O `tgsolutions` não é uma base de software apta a merge de código com o TGR-CRM. Ele é um repositório de referência restrita e evidência auditada. A decisão final deve comparar os módulos documentados com a cobertura do TGR-CRM e, se houver valor, incorporar somente uma matriz de requisitos e links de proveniência documental, sem transportar conteúdo proprietário.

## Comparação funcional preliminar

O mapa AS-IS do pacote descreve plataforma, financeiro/cobrança, vendas/contratos, utilização/férias/pontos, estoque/cotas, comissões, marketing/captação, CRM, cancelamento/retenção, sala de vendas e BI. O TGR-CRM já possui cobertura própria para associado, contrato, parcelas, financeiro, cobrança, reservas, inventário, campanhas, captação, sala de vendas, metas, comissões, CRM, auditoria e dashboards.

As lacunas de maior valor confirmadas por essa referência são: **comissão por regras/faixas e estornos**, **distrato/retenção com reversão financeira e de comissão**, e **uso avançado de pontos/cotas/intercâmbio**. A referência também reforça que a sala precisa combinar casal, check-in, equipe, tempos e brindes — itens que o TGR já iniciou de forma independente.

Nada nesta documentação justifica merge de código. Ela justifica manter o pacote isolado como fonte de requisitos para as próximas ondas, especialmente comissões proporcionais, distrato e utilização avançada.

## Limites confirmados pelo blueprint e pela auditoria de origem

O blueprint organiza os mesmos domínios que o TGR-CRM já está construindo: captação, sala de vendas, inventário/cotas, contrato, financeiro, comissões, CRM, cancelamento, utilização, integrações e BI. Ele também prevê multiempresa/tenancy, enquanto o TGR-CRM tem uma decisão explícita de produto para empresa única. Esse componente, portanto, deve permanecer fora do escopo.

O relatório de auditoria do pacote classifica suas conclusões como observado, inferido ou proposto e preserva pendências humanas para regras exatas de financeiro, comissão, estorno, integração, documentos e permissões locais. Isso elimina qualquer argumento para importar schemas, telas ou supostas regras diretamente. O uso correto é transformar apenas lacunas de alto valor em requisitos novos, revisados pelo negócio e implementados de forma independente.

## Decisão técnica recomendada

**Não realizar merge de árvores Git, arquivos ou histórico.** Manter `tgsolutions` como repositório privado de referência restrita e o TGR-CRM como repositório/produto independente. A união segura é documental: uma matriz de proveniência que cite caminho, tipo de evidência e decisão de produto, sem copiar conteúdo sensível. Essa estratégia protege o código proprietário do TGR, evita carregar cerca de 791 MB de binários, dados e logs, e mantém qualquer reutilização limitada a aprendizado funcional lícito.

## Cruzamento com a matriz vigente do TGR-CRM

A matriz `MATRIZ_TGR_VS_TSE.md` já registra que o TGR-CRM supera a referência em governança, auditoria, eventos, reversão protegida, testes e IA permissionada, mas ainda possui ondas claras para comissão proporcional, distrato, captação offline, frações/semanas, gateway, assinatura, portal e intercâmbio. O inventário do `tgsolutions` confirma essas lacunas em nível de capacidade, sem fornecer uma justificativa legítima para reutilizar sua implementação.

Assim, a integração prática será por **backlog rastreável**, usando a matriz do TGR como documento de produto e o `tgsolutions` somente como referência privada de auditoria. O próximo repositório de código deve ser um GitHub privado chamado `tgr-crm`, com histórico independente e uma nota curta apontando para esta decisão. O pacote `tgsolutions` permanece separado e nunca entra como submódulo, cópia ou remoto de merge.
