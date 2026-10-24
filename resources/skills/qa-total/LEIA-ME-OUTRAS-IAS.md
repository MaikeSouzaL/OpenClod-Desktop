# Usar a skill qa-total fora do Claude Code (Codex, Cursor, Gemini CLI etc.)

A skill é feita de markdown e scripts Python, e qualquer IA que leia arquivos e rode comandos no terminal consegue
usá-la. O que muda é o disparo, o modo multiagente e o nome das ferramentas de navegador.

## 1. Instalar

1. Copie esta pasta inteira para um lugar fixo, por exemplo `~/qa-total/` (no Windows,
   `C:\Users\<voce>\qa-total\`).
2. Instale Python 3.9 ou mais novo. As dependências opcionais (Pillow, PyMuPDF, PyYAML) melhoram os prints e os
   PDFs, mas sem elas os scripts avisam e seguem.
3. Para os PDFs, o Chrome ou o Chromium precisa estar instalado. Os scripts usam o navegador em modo headless, com
   perfil temporário.

## 2. Fazer a IA usar a skill

As outras IAs não carregam a skill sozinhas. Ponha isto no arquivo de instruções do projeto:

| IA | Arquivo |
|---|---|
| Codex (OpenAI) | `AGENTS.md` na raiz do projeto |
| Cursor | `.cursor/rules/qa.mdc` ou `.cursorrules` |
| Gemini CLI | `GEMINI.md` |
| Outras | o arquivo de "system prompt", "rules" ou "instructions" do projeto |

Texto sugerido:

```
## QA
Quando eu pedir para testar, validar, retestar, fazer QA/E2E ou caçar bugs, siga à risca
~/qa-total/SKILL.md e as referências que ele mandar ler. Os scripts estão em ~/qa-total/scripts/.
O perfil deste projeto fica em .qa/PERFIL.md (crie a partir de ~/qa-total/templates/PERFIL-DO-PROJETO.md
na primeira rodada). A rodada só termina quando `python ~/qa-total/scripts/cobertura.py fechar <rodada>`
sair 0.
```

Ao pedir, seja explícito: "faça QA desta tela seguindo o qa-total".

## 3. O que funciona igual

- Todas as regras e fases do `SKILL.md` e das `references/`.
- Os scripts: `cobertura.py` (ledger e gate), `provas.py` e `gerar_pdf.py` (PDF ANTES/DEPOIS), `entregas.py`
  (entrega por branch), `segredos.py`, `escopo_diff.py`, `aprender.py`, `painel.py`, `mensagens.py`, `circular.py`,
  `visual_diff.py` e `fuzz_valores.py`.
- Os espiões JavaScript (`xhr-spy.js`, `toast-observer.js`, `axe-inject.js`), em qualquer navegador onde a IA
  consiga executar JavaScript na página.
- As travas que são script continuam valendo do mesmo jeito: o gate reprova sem prova, sem ANTES/DEPOIS ou sem
  reteste, a máscara de segredo funciona e o aprendizado tem travas.

## 4. O que muda

| No Claude Code | Em outra IA |
|---|---|
| A skill dispara sozinha ao ouvir "testa" | Precisa do texto do item 2 e de um pedido explícito |
| `workflows/qa-total.workflow.js` (multiagente) | **Não roda.** Use só o modo direto, com um agente fazendo as fases em ordem |
| `mcp__claude-in-chrome__*` (sessão logada do usuário) | O navegador que a IA tiver: um MCP de navegador (Playwright MCP, Chrome DevTools MCP, browser-use) ou nenhum |
| `mcp__plugin_playwright_*` / `mcp__playwright-qa__*` | Playwright MCP da outra IA, ou um script Playwright próprio |
| Ferramentas `Read`, `Grep`, `Bash` | As equivalentes da IA (ler arquivo, buscar, terminal) |

Onde o `SKILL.md` ou uma referência cita uma ferramenta pelo nome do Claude, use a equivalente da sua IA. A regra
por trás continua a mesma: validar na sessão do usuário, sem digitar senha.

## 5. Cuidados

- **Login:** a skill proíbe a IA de digitar senha. Deixe a sessão já logada no navegador que ela vai usar, ou
  forneça um token de teste por variável de ambiente (veja `references/execucao-e-evidencias.md`).
- **Sem navegador:** sem um MCP de navegador, a IA testa só API, banco, CLI e código. Os casos de tela ficam como
  `bloqueado` com o motivo, e o gate mostra isso; nada passa calado.
- **Guardas de texto:** "produção só leitura", "não commitar" e "não fazer login" dependem de a IA respeitar o
  `SKILL.md`. Repita as mais importantes no arquivo de instruções do projeto (item 2).
- **Python:** em macOS e Linux, use `python3` no lugar de `python`.
- **Autoaprendizado:** `aprender.py` grava nesta pasta. Se várias IAs usarem a mesma cópia, as lições ficam
  compartilhadas. Se não quiser isso, mantenha uma cópia por IA.

## 6. Conferir se está tudo certo

```
python ~/qa-total/scripts/aprender.py validar
python ~/qa-total/scripts/cobertura.py --help
```

O primeiro comando precisa sair com `0 erro(s)`.
