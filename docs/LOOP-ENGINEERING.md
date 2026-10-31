# Código Loop Engineering

Um modo do agente em que um **maestro** coordena uma equipe de especialistas e repete o ciclo
**definir → planejar → fazer → verificar → criticar → julgar** até o pedido estar **provadamente**
pronto. Quem decide a parada é o harness, não a palavra do modelo: o loop só termina com PRONTO
quando o juiz foi chamado na volta, o `tester` foi chamado no loop se o código mudou, e todos os
critérios de pronto estão provados (os comandos são rodados de novo pelo próprio harness).

## Como usar

1. Numa sessão, clique em **+** no compositor → **Modo do agente** → **Código Loop Engineering**.
2. O painel acima do compositor explica o modo e mostra o orçamento (padrão: 8 voltas ou 90 min).
3. Descreva a tarefa. O painel acompanha: volta N de M, minutos usados, fase do ciclo, cada critério
   (✓ provado, ! falhou com a linha que falhou, ○ pendente), agentes chamados na volta, o último
   parecer do juiz e, no fim, por que o loop parou.
4. Se o loop parar sem terminar (orçamento, pergunta, estagnação), responda ou mande **continue**: a
   próxima mensagem retoma o mesmo loop, com os mesmos critérios e um orçamento novo.

O orçamento fica em **Configurações → Harness → Loop Engineering** (voltas e minutos por pedido). Se
você pedir na mensagem ("até 12 voltas"), o maestro pode passar isso ao definir os critérios (teto de
30 voltas e 480 min).

## A equipe

| Agente | Papel | |
| --- | --- | --- |
| Maestro (o próprio modo; também `loop-conductor` para chamar de outros modos) | divide a tarefa, chama os especialistas (em paralelo quando independentes), decide a próxima volta | novo |
| `done-criteria` | transforma o pedido em critérios verificáveis, cada um com o comando que o prova | novo |
| `loop-judge` | roda as checagens de novo, confere o que comando não prova e dá PRONTO, CONTINUAR ou BLOQUEADO | novo |
| `app-prover` | sobe o projeto (servidor, Electron, CLI, API), percorre o fluxo pedido e guarda prints e logs | novo |
| `loop-critic` | tenta quebrar a entrega e os próprios critérios ("esse teste prova mesmo o pedido?") | novo |
| `loop-memory` | grava o que foi tentado e por que falhou; lê no começo da volta seguinte | novo |
| `planner`, `strategist`, `explorer`, `researcher`, `agent-smith` | planejar e entender; criar um especialista que falta | já existiam |
| `coder`, especialistas de linguagem, `css-specialist`, `svg-designer`, `computer-operator`, `docs-writer` | fazer | já existiam |
| `tester` | escreve os testes que provam o pedido e roda a suíte; o maestro o chama no Verificar sempre que faltam testes (quem fez o código não escreve os testes que vão prová-lo) | já existia |
| `verifier`, `web-qa`, `mobile-qa`, `qa-lead`, `svg-verifier`, `reviewer`, `security-auditor`, `debugger`, `playwright-test-healer` | verificar, criticar e corrigir | já existiam |

"Todas as habilidades": o modo tem as ferramentas de Código, Computer Use e Navegar, as skills
(`use_skill`), os conectores MCP e a ferramenta `loop`. Os especialistas chamados pelo maestro podem
usar qualquer ferramenta do modo (exceto `loop`), mesmo as que o maestro ainda não carregou.

## A ferramenta `loop` (só o maestro)

| Ação | O que faz |
| --- | --- |
| `define` | registra os critérios (`text` + `check` opcional: comando com exit 0 = cumprido); aceita `max_rounds`/`max_minutes` pedidos pelo usuário |
| `check` | roda agora o comando de cada critério e marca provado/falhou com o fim da saída |
| `verdict` | registra o parecer da volta: `done`, `continue` (com `missing`) ou `blocked` (com a pergunta) |
| `status` | mostra o estado |

Cada comando de critério passa pela **mesma política do `run_command`**: regras, bloqueio de
credenciais, aprovação do modo de permissão e o guarda de comandos destrutivos. Os hooks
`PreToolUse` de `run_command` não disparam para essas checagens (elas não são chamadas de ferramenta
do modelo). Tempo máximo de cada checagem: 10 min.

## Quando o loop para

| Situação | Estado | O que acontece |
| --- | --- | --- |
| juiz chamado na volta, `tester` chamado no loop se algum arquivo de código mudou no turno, todo critério com comando passou na hora, todo critério sem comando tem prova | **Concluído** | o maestro escreve o relatório final |
| `verdict blocked` (senha, decisão de produto, ação irreversível) | **Aguardando você** | a pergunta vai para o usuário |
| acabaram as voltas ou os minutos | **Orçamento esgotado** | uma última resposta sem ferramentas: o que ficou pronto, o que falta |
| a mesma falha em 3 voltas seguidas | (continua) | o harness manda mudar de estratégia de verdade |
| a mesma falha depois de 2 mudanças de estratégia (5 voltas) | **Estagnado** | o maestro explica e faz uma pergunta objetiva |
| mensagem que não é tarefa ("oi") e o maestro não define critérios depois de um lembrete | **Aguardando você** | a resposta fica como está |
| o usuário parou, erro do provedor | **Parado** / **Aguardando você** | a próxima mensagem retoma o loop |

PRONTO sem o juiz, sem o `tester` depois de mudar código, com uma checagem falhando ou sem prova vira
**CONTINUAR** automaticamente, com a lista do que falta. "Código" são arquivos-fonte (`.js`, `.ts`,
`.py`, `.go`, `.rs`, `.cs`, `.vue`...; veja `isCodePath`); docs, dados e configuração não exigem o
tester. A regra existe porque, sem ela, o maestro escrevia os testes do próprio código em 2 de 3
rodadas reais.

"A mesma falha" é comparada sem os números (durações, contagens e linhas mudam de uma execução para
outra).

## Limites

- **Por volta:** iterações, chamadas de ferramenta, tempo do turno e o teto de 24 subagentes valem
  de novo a cada volta (Configurações → Permissões → Limites de execução).
- **Pelo loop inteiro:** as voltas e os minutos do orçamento, e os limites de **tokens e custo do
  turno**, que continuam somando (são a proteção de gasto).
- Cancelar o turno para o loop inteiro, inclusive os especialistas que estão rodando.

## Onde está no código

| Peça | Arquivo |
| --- | --- |
| Contratos (`AgentMode 'loop'`, `LoopState`, evento `loop`, `loopBudget`) | `src/shared/types.ts` |
| Máquina de estados pura (critérios, veredito, portão entre voltas, estagnação, textos injetados) | `src/core/loop/engine.ts` |
| Ferramenta `loop` e as checagens com a política do `run_command` | `src/core/tools/loop.ts` |
| Portão no fim de cada resposta, contadores por volta, árvore de agentes por volta, ferramentas dos especialistas | `src/core/agent/runner.ts` |
| Instruções do maestro | `src/core/agent/context.ts` (`MODE_GUIDANCE.loop`) |
| Ferramentas do modo | `src/core/security/permissions.ts` |
| Os seis agentes novos | `src/core/agents/definitions.ts` |
| Menu, painel e configurações | `Composer.tsx`, `LoopDock.tsx` + `loop-dock.css`, `lib/loop-view.ts`, `SettingsDialog.tsx` |

## Verificação

- Testes: `npx vitest run tests/loop-engine.test.ts tests/loop-runner.test.ts tests/loop-team.test.ts`
  (o runner com checagens de verdade, voltas, orçamento, estagnação, cancelamento e retomada).
- App real, modelo real, perfil descartável:
  `node scripts/ui-loop.cjs --root <snapshot> --provider opencode-go --model deepseek-v4.1-flash`
  (a opção no menu, o painel, um pedido de verdade em voltas até PRONTO, prova independente com
  `node --test` e o CLI rodados pelo próprio script, Configurações → Harness). Gere o snapshot com
  `npx electron-vite build --outDir <pasta>` + `node scripts/snapshot-app.cjs loop --from <pasta>`.
  O roteiro deixa só o provedor escolhido no perfil descartável, para os especialistas com
  `model: best` (o juiz, o app-prover) usarem o mesmo modelo.
