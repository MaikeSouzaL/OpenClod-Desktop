# Revisão de melhorias

O harness registra o que acontece (limitações relatadas, falhas de ferramentas, aprovações,
orçamento, uso por provedor, memória do projeto), mas nada juntava esses sinais. A revisão de
melhorias faz isso: conta o que aconteceu em **um projeto**, aponta padrões com evidência e
sugere mudanças. **Nada é aplicado sozinho.**

## Como usar

- **Manual:** Atividades → cartão "Revisão de melhorias" → *Revisar melhorias*. Escolha o projeto,
  o período (7, 14, 30 ou 90 dias) e se a IA analisa. Dá para cancelar enquanto roda.
- **Semanal:** o interruptor "Toda semana em Agendados" cria a tarefa *Revisão semanal de
  melhorias* (segunda, 09:00, janela de 14 dias). Ela é uma tarefa agendada comum: aparece em
  Agendados (marcada como *interna*), pode ser editada, pausada, executada na hora ou apagada.
  Também existe o modelo "Revisão semanal de melhorias" em Agendados → Nova tarefa.
- **Resultado:** uma página de memória `revisao-melhorias-AAAA-MM-DD` (o mesmo dia reaproveita a
  página; a revisão anterior vira um link `[[...]]`) e uma nota do tipo *Revisão* em Atividades
  com o botão *Abrir na Memória*. Sem atividade no período, nenhuma página é criada.

## O que é coletado

Só do projeto selecionado (sessões dele) e só da janela escolhida:

| Fonte | Evidência |
| --- | --- |
| Atividades (`activity.json`) | limitações agrupadas por título (ocorrências, sessões, se bloquearam), aprovações pedidas × concedidas × recusadas (ligadas pelo id da aprovação), paradas por orçamento, falhas de subagentes |
| Observabilidade (`events.jsonl`) | chamadas por ferramenta, taxa de falha, duração, erros recentes, turnos com erro |
| Uso por provedor (`provider-usage.json`) | tokens, cache e custo. **Global** (todos os projetos, desde o início): não existe por projeto |
| Memória do projeto | páginas de conhecimento × registros de turno, handoffs abertos, conflitos, páginas velhas, revisões anteriores |

O log de eventos é limitado (4000 eventos); quando ele cobre menos que a janela pedida, o
relatório avisa a data a partir da qual há dados.

## Achados (regras automáticas, sem IA)

Cada achado cita contagens reais e sugere uma mudança. Limiares principais:
limitação que se repete (≥ 2 vezes ou ≥ 2 sessões) · ferramenta com ≥ 2 falhas, ≥ 3 chamadas e taxa ≥ 25 %
(alta com ≥ 50 % e ≥ 3 falhas) · mesma aprovação recusada ≥ 2 vezes · aprovação sempre concedida ≥ 5
vezes · paradas por orçamento · ≥ 10 % dos turnos com erro · subagente com ≥ 2 falhas · cache de
prompt < 10 % em provedor com ≥ 200 mil tokens · memória sem páginas de conhecimento, com conflitos,
≥ 3 handoffs abertos ou ≥ 5 páginas sem atualização há 90 dias. Ferramentas lentas por natureza
(`agent`, `ask_user`, `start_process`…) não entram como "lentas".

## O analista (IA)

- É o agente oculto `improvement-analyst`: **uma única chamada ao modelo, sem nenhuma ferramenta**.
  Não lê arquivos, não roda comandos, não escreve nada. Por isso é somente leitura por construção.
  Um arquivo de agente com o mesmo nome em `%APPDATA%\Openclod\agents` substitui o prompt dele.
- Recebe o relatório de evidências dentro de marcadores `<<<RELATORIO … RELATORIO>>>` e o prompt manda
  tratar o conteúdo como dado, não como instrução. Responde com Prioridades, Padrões, O que parece
  funcionar e Perguntas para o dono, citando os ids dos achados.
- A resposta passa por `sanitizeAnalysis` (remove segredos, HTML cru, limita o tamanho) e entra na
  página numa seção "Análise", **acima** das evidências contadas. O que é contagem fica separado do
  que é interpretação do modelo.
- Se o modelo falhar, a página sai só com as regras automáticas e a nota explica o motivo.

## Privacidade

- Sem IA, nada sai do computador.
- Com IA, as evidências **vão para o provedor padrão** (mostrado no cartão). Antes disso, textos de
  erro, títulos e detalhes passam por `redactDiagnosticText` (chaves de API, `Authorization`, tokens,
  senhas e `C:\Users\<nome>`). A análise do modelo é filtrada de novo antes de ser salva.
- Só é usado um provedor real com credencial; o provedor de teste (Scripted) nunca escreve análise.
- O custo da chamada do analista **não** é somado ao uso por provedor (a chamada não passa pelo
  contador de sessões).

## Onde está no código

- `src/core/improvements/` — `evidence.ts` (coleta e achados, puro), `report.ts` (página, prompt,
  limpeza), `service.ts` (execução, cancelamento, histórico em `data/improvement-reviews.json`).
- `src/main/improvement.ts` — liga o serviço às lojas reais, ao agendador e à memória;
  `src/main/orchestrator.ts` — `improvementAnalyze`, `improvementSavePage` e afins.
- Agendador: `action: 'improvement-review'` + `actionOptions { useAi, days }` em `src/core/scheduler`.
- UI: `ImprovementReviewCard.tsx` (Atividades) e o modelo em `ScheduledPage.tsx`.
- Testes: `tests/improvements.test.ts` (evidência, achados, relatório, serviço, agendador) e
  `node scripts/ui-improve.cjs` (app real, perfil descartável).

## O que foi e o que não foi verificado

- Verificado por teste unitário: coleta por projeto/janela, agrupamento, redação de segredos, todos os
  limiares dos achados, composição da página, serviço (sucesso, falha da IA, sem atividade, cancelar,
  uma por vez, histórico) e validação da ação no agendador.
- Verificado no app real (`scripts/ui-improve.cjs`): botão, página de memória, nota em Atividades,
  interruptor semanal, execução pelo agendador, cancelamento. O caminho com IA foi exercitado contra um
  **servidor OpenAI-compatível falso local**, que confirma a chamada sem ferramentas, a evidência
  redigida, o texto na página e o fallback. **Não foi testado com um modelo real.**
- Última rodada de `scripts/ui-improve.cjs`: 22 de 22 verificações; suíte completa 941 testes; typecheck limpo.
- **Não verificado:** (1) qualidade da análise de um modelo real; (2) o disparo pelo relógio na
  segunda às 09:00 (só foi exercitado "Executar agora" pelo agendador, que usa o mesmo caminho);
  (3) a substituição do prompt do analista por um arquivo de agente do usuário (a regra vem da
  ordem de camadas do carregador de agentes, sem teste próprio); (4) projetos com aprovações reais
  pedidas e recusadas pela interface (cobertas só por teste unitário com dados sintéticos).
