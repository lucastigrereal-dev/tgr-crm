# IA Permissionada — TSE Exclusivo

## Objetivo

O copiloto do associado é uma camada de **consulta e recomendação**, disponível na ficha 360°. Ele ajuda o time a interpretar o contexto operacional existente, mas não altera cadastro, contrato, cobrança, reserva, tarefa ou desconto.

> A IA não é um usuário do CRM. Ela não executa ação nenhuma. Toda recomendação exige decisão e execução explícita de uma pessoa autorizada.

## Recuperação permissionada

O contexto é montado no servidor antes da chamada ao modelo. O perfil do usuário decide quais classes de evidência entram na análise.

| Perfil | Evidências permitidas | Evidências bloqueadas |
|---|---|---|
| Administração | Relacionamento, contratos, comercial, reservas e financeiro | Documentos, endereço, CPF/CNPJ, anexos e observações privadas |
| Comercial | Relacionamento, tarefas, oportunidades e contratos | Parcelas, valores financeiros, documentos e reservas |
| Financeiro | Contratos e parcelas | Interações, oportunidades, tarefas e reservas |
| Atendimento | Interações, tarefas, contratos e reservas | Oportunidades, parcelas e valores financeiros |

O payload também limita quantidade de itens e tamanho de texto. Interações são tratadas como **dados não confiáveis**: instruções presentes nelas não são comandos para o modelo.

## Resposta e evidências

A resposta é validada contra JSON Schema estrito e sempre contém resposta, nível de confiança, identificadores de evidência, ações sugeridas e limites. O servidor elimina IDs de evidência não presentes no contexto permitido. A tela mostra cada evidência usada e aplica o selo **“Aprovação humana obrigatória”** a qualquer ação sugerida.

## Auditoria e integração

Cada consulta registra auditoria e o evento `ai.assistance.requested`. O feed de integração recebe apenas `role`, `evidenceCount` e `model`; pergunta, resposta e contexto recuperado não são publicados.

## Modelo e custos

O servidor consulta o catálogo vivo e prioriza `gpt-5-mini`, usando outro modelo do catálogo apenas se necessário. A chamada ocorre somente após a pessoa enviar uma pergunta; não há processamento em lote, geração automática de resumo nem chamadas em background.

## Limites atuais

Esta primeira versão recupera dados estruturados da ficha do associado. Ela ainda não indexa anexos, PDFs ou base documental semântica. Qualquer evolução para busca vetorial, anexos ou automação deverá preservar os mesmos filtros de perfil, citar fonte e manter aprovação humana.
