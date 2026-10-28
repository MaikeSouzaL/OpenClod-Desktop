# PROMPT — APROVEITAMENTO MÁXIMO DOS 55 REPOSITÓRIOS CLONADOS

> Use este prompt em uma sessão nova, com esforço alto, dentro da raiz do
> projeto. Ele é autocontido: não depende do histórico da conversa anterior.

---

## 0. Verdade atual (leia antes de planejar)

Hoje o harness **não** usa o código-fonte de todos os repositórios clonados.
O estado real é:

- **55 repositórios clonados** em `repositorios/` (54 em
  `repositorios/_research/<categoria>/` + `repositorios/opencode`), clones rasos,
  ~8,0 GB. Inventário em `docs/research/REPOSITORY_INVENTORY_2026-10-25.md` e
  `docs/research/CLONE_STATUS.json`.
- **2 adaptações de código com origem marcada**:
  `src/core/agents/definitions.ts` (prompts do OpenCode) e
  `src/renderer/src/lib/graph-layout.ts` (layout do ai-memory).
- **Componentes de terceiros em runtime**: `ripgrep` (binário), `open-computer-use`
  (binário), Playwright (npm) e o sidecar `ai-memory`.
- **O restante das funcionalidades foi reimplementado**, não portado: MCP,
  worktrees, rewind, plugins, scheduler, memória, TTS, OCR, transcrição,
  documentos, imagens, updater, notificações, diagnóstico e backup.

Portanto: o acervo foi **estudado**, mas o aproveitamento de código é **pontual**.
A missão deste prompt é mudar isso de forma sistemática, module a module.

## 1. Missão

Percorrer **os 55 repositórios**, identificar cada módulo que seja melhor do que
o nosso ou que cubra uma capacidade ausente, e **incorporar de fato** o que for
compatível — com procedência, licença e testes.

A meta é **aproveitamento máximo verificável**, não cópia bruta. Cada módulo
avaliado recebe uma decisão explícita: **portar**, **adaptar**, **reimplementar
a abordagem**, **usar como dependência/binário** ou **rejeitar com motivo**.

É proibido entregar apenas um relatório. O trabalho termina com código
integrado, testado e documentado.

## 2. Regras invioláveis

1. **Não copie repositórios inteiros.** Nada de `cp -r`, `rsync` ou vendorizar
   uma árvore completa. Só entram arquivos/módulos identificados e justificados.
2. **Nenhum código entra sem licença verificada.** Ver §3.
3. **Priorize a stack atual (TypeScript/Node + Electron).** Código Rust, Go,
   Python ou C entra como binário auxiliar, sidecar ou porta seletiva — nunca
   como dependência de runtime sem justificativa escrita.
4. **Não duplique funcionalidade.** Se já existe equivalente testado, preserve e
   só substitua se houver ganho concreto (desempenho, correção, cobertura).
5. **Preserve interfaces públicas, dados e configurações existentes.**
6. **Toda adaptação leva cabeçalho de origem** no arquivo:
   `// Ported from <repo> (<commit>) — <SPDX>. Adapted for Openclod.`
7. **Toda integração leva teste.** Sem teste executado, não está concluído.
8. **Não invente resultado.** Rode o comando, cole a saída real.
9. **Não leia `.pen` nem segredos.** `secrets.bin`, tokens e `.env` ficam fora.
10. **Trabalhe em fatias verticais** (uma capacidade ponta a ponta por vez), não
    em 20 ports pela metade.

## 3. Gate de licença (obrigatório)

Classificação detectada nos clones. Confirme arquivo a arquivo antes de copiar;
esta tabela é o ponto de partida, não a prova final.

| Grupo | Repositórios | Regra |
|---|---|---|
| **MIT** | OpenHands, ast-grep, litellm, awesome-mcp-servers, stagehand, browser-use, ripgrep, win-computer-use, codemirror, crewAI, desktop-use, electron, llama.cpp, kilocode, langgraph, langfuse*, LSP, monaco, python-sdk, ollama, opencode, promptfoo, pydantic-ai, llama_index, SWE-agent, tree-sitter, xterm.js | Portar com aviso de copyright + texto MIT. |
| **Apache-2.0** | agno, aider, sqlite-vec, goose, chroma, cline, deepeval, terax-ai, mem0, playwright, modelcontextprotocol (3 repos), codex, open-interpreter, OpenRouter SDK, opentelemetry-js, puppeteer, qdrant, qwen-code, scip, tauri, vercel/ai | Portar com copyright, texto Apache, `NOTICE` se existir e indicação de alterações. |
| **BSD / ISC** | pyautogui (BSD), autogen (ISC) | Portar mantendo aviso e texto. |
| **Copyleft — exigir cuidado** | `universal-ctags` (**GPL-2.0**), `zed` (**GPL-3.0 em parte, Apache em parte**), `eclipse.jdt.ls` (**EPL-2.0**) | **Não copiar código para dentro do harness.** Usar como serviço externo/CLI ou reimplementar a abordagem. Para Zed, verificar o cabeçalho de cada crate antes de qualquer uso. |
| **Misto** | `langfuse` (MIT + pastas `ee/` proprietárias) | Só usar fora de `ee/`, `web/src/ee/`, `worker/src/ee/`, `packages/shared/src/server/ee/`. |
| **Sem licença (fora dos 55)** | `claw-code-local`, `Mcp.ComputerUse` | Apenas referência conceitual. Nenhum código. |

Registre SPDX, commit e caminho de cada arquivo incorporado. Em dúvida, **não
copie**: reimplemente e documente a fonte da ideia.

## 4. Fase 1 — Baseline do harness

Antes de tocar em código:

1. Leia `AGENTS.md`, `src/` (core, main, renderer, shared), `tests/` e
   `THIRD_PARTY_NOTICES.md`.
2. Rode e guarde a saída real de:
   ```powershell
   npm run typecheck
   npx vitest run
   npm run build
   npm audit --omit=dev
   ```
3. Liste as capacidades atuais por subsistema: loop do agente, provedores,
   ferramentas, permissões, contexto, memória, MCP, sessões, worktrees, rewind,
   terminal, navegador, Computer Use, UI, plugins, scheduler, observabilidade,
   testes, updater.
4. Marque cada uma como: `completa`, `parcial`, `quebrada`, `ausente`.
5. Registre o estado do Git. Não sobrescreva alterações locais.

## 5. Fase 2 — Catálogo de módulos dos 55 repositórios

Para cada repositório, examine o **código real** (não o README):

- entrypoints e arquitetura;
- módulos de ferramentas e adaptadores;
- interfaces públicas;
- configuração e estado;
- integração com LLM;
- execução de processos;
- tratamento de erro;
- testes e exemplos;
- licença e dependências.

Produza uma linha por **módulo candidato** em
`docs/research/CODE_REUSE_MATRIX.md`:

| Campo | Conteúdo |
|---|---|
| `repo` | nome e URL |
| `commit` | `git -C <path> rev-parse HEAD` |
| `license` | SPDX + arquivo |
| `path` | caminho do módulo no clone |
| `capability` | o que ele faz |
| `ours` | arquivo/feature equivalente no harness (ou "ausente") |
| `decision` | `port`, `adapt`, `reimplement`, `dependency`, `reject` |
| `score` | 0–25 conforme §6 |
| `reason` | justificativa curta, em uma frase |
| `risk` | licença, stack, manutenção, tamanho |

Nenhum repositório pode ficar sem linha. Se não houver nada aproveitável,
registre `reject` com o motivo.

## 6. Fase 3 — Pontuação e priorização

Avalie cada módulo de 0 a 5 em cinco critérios:

| Critério | 0 | 5 |
|---|---|---|
| **Benefício** | cosmético | corrige defeito real ou capacidade ausente |
| **Compatibilidade** | outra stack/paradigma | TypeScript/Node, encaixa sem reescrever |
| **Licença** | copyleft/sem licença | MIT/Apache/BSD/ISC |
| **Custo de integração** | semanas | horas |
| **Risco/manutenção** | alto, sem testes | baixo, testado e pequeno |

Regras:

- `license < 3` ou `compatibilidade < 3` ⇒ **não portar** (no máximo reimplementar).
- Priorize `score >= 18` e fatias que destravem outras.
- Empate: prefira o módulo menor, com testes e sem dependência nova.
- Uma dependência nova só entra se substituir código nosso ou remover risco.

## 7. Fase 4 — Integração em fatias verticais

Para cada módulo escolhido, nesta ordem:

1. **Ler** o código-fonte completo do módulo e seus testes.
2. **Mapear** dependências e interfaces usadas.
3. **Decidir** entre port literal, adaptação ou reimplementação da abordagem.
4. **Integrar** respeitando `src/core` puro (sem Electron), `src/main`,
   `src/shared` e `src/renderer`.
5. **Adicionar cabeçalho de origem** e entrada em `CODE_PROVENANCE.md`.
6. **Escrever/adaptar testes** cobrindo o caminho feliz e as bordas.
7. **Rodar** typecheck, testes focados e build.
8. **Se houver UI**: validar IPC, estados de erro e um E2E real.
9. **Atualizar** `THIRD_PARTY_NOTICES.md` quando houver código ou binário novo.
10. **Commitar** a fatia isolada, com mensagem citando a origem.

Definição de fatia pronta: capacidade utilizável pelo agente ou pelo usuário,
com teste automatizado e nenhuma regressão.

## 8. Fase 5 — Verificação obrigatória

Após cada fatia e no final:

```powershell
npm run typecheck
npx vitest run
npm run build
npm audit --omit=dev
```

Gate final:

- [ ] typecheck limpo nos dois projetos;
- [ ] suíte completa verde, sem testes desabilitados;
- [ ] build Electron concluído;
- [ ] `npm audit --omit=dev` sem vulnerabilidades;
- [ ] nenhuma funcionalidade existente quebrada;
- [ ] todo arquivo portado tem origem, commit e licença registrados;
- [ ] nenhum código GPL/EPL/sem licença incorporado;
- [ ] nenhum segredo, token ou dado pessoal em log/teste.

## 9. Fase 6 — Procedência e avisos

Crie/atualize:

- `docs/research/CODE_REUSE_MATRIX.md` — todos os módulos avaliados.
- `docs/research/CODE_PROVENANCE.md` — só o que entrou:

  ```markdown
  ## <arquivo destino>
  - Origem: <repo> — <caminho no clone>
  - Commit: <sha>
  - Licença: <SPDX> (<arquivo LICENSE>)
  - Alterações: <resumo>
  - Testes: <arquivos de teste>
  ```

- `THIRD_PARTY_NOTICES.md` — texto da licença, copyright e `NOTICE` quando
  aplicável.
- `docs/research/REPOSITORY_INVENTORY_2026-10-25.md` — atualizar só se algum
  commit mudar.

## 10. Entregável final (formato obrigatório)

1. Repositórios examinados: 55/55 (lista ou contagem por categoria).
2. Módulos avaliados: total e por decisão (`port`/`adapt`/`reimplement`/
   `dependency`/`reject`).
3. O que foi efetivamente incorporado, com arquivo destino e origem.
4. O que foi reimplementado por causa de licença ou stack.
5. O que foi rejeitado e por quê.
6. Dependências novas e justificativa.
7. Testes executados com números reais (arquivos, testes, falhas).
8. Typecheck, build e audit: saída real.
9. Riscos e pendências.
10. Próxima fatia recomendada.

## 11. Anti-falso-positivo

- Não marque nada como concluído sem saída de teste.
- Não diga que um recurso existe porque o README do projeto diz.
- Não copie um arquivo sem lê-lo inteiro.
- Não adapte código de licença duvidosa "só um trechinho".
- Não esconda falha de teste atrás de `skip`, `only` ou timeout maior.
- Não substitua uma implementação nossa funcional sem benchmark ou bug
  reproduzível que justifique.

## 12. Ordem sugerida de ataque

1. **Agente/loop e ferramentas** — opencode, codex, aider, cline, goose.
2. **Edição e contexto de repositório** — aider (repo map, edit formats),
   opencode (compatibilidade de modelos, compactação), SWE-agent (ciclo de
   correção).
3. **MCP** — typescript-sdk, servers, modelcontextprotocol (resources, prompts,
   transporte HTTP).
4. **Memória e recuperação** — mem0, llama_index, sqlite-vec (já temos memória
   wiki; avaliar só o que falta).
5. **Provedores e roteamento** — litellm (normalização, fallback, custos),
   vercel/ai, OpenRouter SDK.
6. **Computer Use e navegador** — win-computer-use, desktop-use, browser-use,
   stagehand (avaliar contra o que já funciona).
7. **UI/editor/terminal** — xterm.js, monaco, codemirror (só o que não exigir
   troca de stack).
8. **Observabilidade e testes** — open-telemetry-js, promptfoo, deepeval,
   langfuse (fora de `ee/`).

## 13. Comandos de apoio

```powershell
# inventário rápido
Get-ChildItem repositorios/_research -Directory |
  ForEach-Object { Get-ChildItem $_.FullName -Directory } |
  ForEach-Object { "{0}`t{1}" -f $_.Name, (git -C $_.FullName rev-parse --short HEAD) }

# atualizar um clone raso
git -C repositorios/_research/<categoria>/<repo> fetch --depth 1
git -C repositorios/_research/<categoria>/<repo> reset --hard origin/HEAD

# conferir licença de um módulo
Get-ChildItem repositorios/_research/<categoria>/<repo> -File | Where-Object Name -match 'LICEN|COPYING'
```

## 14. Critério de sucesso

O trabalho é bem-sucedido quando:

- os 55 repositórios têm avaliação registrada;
- todo módulo com `score >= 18` e licença compatível foi integrado ou tem
  justificativa técnica escrita para não ter sido;
- cada integração tem teste, procedência e aviso de licença;
- a suíte continua verde e o app continua funcionando;
- o relatório final permite auditar **o que veio de onde** sem abrir o código.
