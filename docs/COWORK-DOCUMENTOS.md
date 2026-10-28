# Cowork: .docx, .xlsx e .pptx de verdade, sem depender do Python do usuário

Resposta aos itens C04 e R3 de [`COWORK-ESTUDO.md`](COWORK-ESTUDO.md): o Cowork entregava documentos reais, mas só porque o modelo escrevia
scripts que usavam `python-docx`, `openpyxl` e `python-pptx` **do PC do usuário** (e instalava o `python-pptx` com `pip`, sem perguntar).
Agora o Python embutido do app traz as bibliotecas, o `run_command` o encontra, há skills com receitas testadas e uma checagem antes de começar.

## O que mudou

| Peça | Onde | O que faz |
|---|---|---|
| Bibliotecas no runtime | [`scripts/embed-office.mjs`](../scripts/embed-office.mjs) | Instala no `resources/runtime/python` as rodas fixas (versão **e** sha256): python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2, XlsxWriter 3.3.0, lxml 6.1.1, Pillow 12.3.0 e et-xmlfile 2.0.0 (o `typing-extensions` já vem do `embed-stt`). Licenças em `resources/licenses/office/`, entradas no `MANIFEST.json` (grupo `office`) e em [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Verifica num ambiente limpo (`PATH` vazio): importa tudo, gera e reabre um .docx, um .xlsx e um .pptx. |
| Comandos no `PATH` | [`resources/office/bin`](../resources/office/bin), [`src/core/util/office-runtime.ts`](../src/core/util/office-runtime.ts), [`src/core/tools/shell.ts`](../src/core/tools/shell.ts) | O `run_command` (e o `start_process`) põem no `PATH` de comandos locais `openclod-python` (o Python embutido) e `openclod-office` (conferência). `OPENCLOD_PYTHON` aponta para o interpretador. |
| `python` do computador | idem | Fica como está: é o Python do usuário. Só quando o computador **não tem Python utilizável** (nenhum, ou o atalho da Microsoft Store), `python` e `python3` passam a apontar para o embutido (`resources/office/bin-fallback`). Um `python` que existe, mesmo sem as bibliotecas, não é trocado: quem roda Django ou pandas no Code continuaria quebrado. |
| Dica de recuperação | `shell.ts` | Um comando que falha com `No module named 'docx'` (ou `openpyxl`, `pptx`, `PIL`, `lxml`, `xlsxwriter`) volta com "rode o mesmo script com `openclod-python`". |
| Sem instalar o que já está lá | `shell.ts` | No Cowork, `pip install python-docx openpyxl ...` (e `python -m pip`, `uv pip`, `conda`, `poetry add`) é **recusado** com a explicação; outros pacotes seguem a regra do prompt (pedir aprovação). No Code nada é recusado. |
| Construtores | [`resources/office/pylib/openclod_office`](../resources/office/pylib/openclod_office) | `docx_report.Report`, `xlsx_book.Book`, `pptx_deck.Deck`, `charts` (PNG com Pillow), `brl`/`num`/`pct`. Tipografia, tabelas com cabeçalho e total, rodapé "Página X de Y", gráficos e tabelas **nativos** no Excel e no PowerPoint, fórmulas reais com valor em cache. Ficam no código-fonte e entram no `sys.path` por uma linha relativa no `python310._pth` (`..\..\office\pylib`): sem cópia, sem versão velha. |
| Conferência | [`resources/office/forja_office.py`](../resources/office/forja_office.py) (`openclod-office`) | `check` (bibliotecas e LibreOffice), `inspect` (títulos, tabelas, fórmulas, gráficos, slides e **avisos**: placeholder vazio, texto que transborda, número guardado como texto, fórmula sem valor ou com erro...), `pdf` e `recalc` (LibreOffice: recalcula **tudo** e acusa `#NAME?`, `#DIV/0!` e valores em cache diferentes). Não precisa de captura de tela. |
| Skills | [`resources/skills/docx`](../resources/skills/docx), [`xlsx`](../resources/skills/xlsx), [`pptx`](../resources/skills/pptx) | Instruções próprias (nada copiado das skills da Anthropic), cada uma com uma receita completa em `receitas/`: relatório com resumo executivo, tabela e gráfico; planilha com `Dados` + `Resumo` de fórmulas reais (SUMIF, total, média mensal, atingimento da meta) e gráfico; apresentação de 5 slides com indicadores, gráfico nativo, tabela e notas. Cada receita é também um **comando de uma linha** (`openclod-python receitas\relatorio.py vendas.csv --saida ... --rodape "texto da pasta" --meta Sul=150000 --conclusao "..."`, `--help` lista as opções): lê CSV com `,` ou `;`, números pt-BR e cabeçalho com acento, e diz quais colunas faltam. É o "caminho rápido" das skills; o "caminho livre" (script próprio com os construtores) fica para outros dados e documentos. |
| Prompt | [`src/core/agent/context.ts`](../src/core/agent/context.ts) | A seção "Superfície Cowork" manda carregar a skill, rodar com `openclod-python` e conferir com `openclod-office inspect`, sem `pip`. |
| Contexto da ferramenta | [`src/core/tools/types.ts`](../src/core/tools/types.ts), [`runner.ts`](../src/core/agent/runner.ts) | `ToolContext.surface` (chat, cowork ou code), para que as regras do Cowork não valham no Code. |
| `%TEMP%` nas ferramentas de arquivo | [`src/core/security/policy.ts`](../src/core/security/policy.ts) (`expandLeadingEnv`) | O prompt do Cowork manda deixar scripts em `%TEMP%`, mas só o shell expandia isso: `write_file("%TEMP%\gerar.py")` criava uma pasta chamada `%TEMP%` dentro da pasta do usuário. Agora um `%TEMP%`, `%TMP%`, `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`... **no começo** do caminho é expandido (a checagem de pastas autorizadas continua a mesma). |

## A checagem antes de começar

Cada skill começa por `openclod-office check`, que mostra o Python embutido, as versões das bibliotecas e se há LibreOffice, e termina com "Tudo pronto. NÃO instale pacotes". Se faltar algo (build sem o runtime), o modelo é mandado dizer ao usuário o que falta e pedir aprovação, em vez de instalar sozinho.

## Alternativa avaliada: ferramenta `document_create`

**Decisão: não criar.** A falha do estudo era de ambiente, não de capacidade (o modelo já escreve python-docx/openpyxl/python-pptx direito). Uma ferramenta exigiria um formato próprio de descrição de documentos, que alguém teria de manter e que teria de cobrir tudo o que o usuário pede, ou o modelo voltaria a escrever script. Uma ferramenta a mais também custa contexto (as ferramentas de documentos são sob demanda: `tool_search` + `tool_load` antes do primeiro uso). Os construtores `openclod_office` dão o mesmo ganho (poucas linhas, acabamento igual a cada vez) e o modelo continua com a API completa quando precisa (`doc.doc`, `book.workbook`, `deck.prs`). Reavaliar se a execução real mostrar modelos fracos errando a API dos construtores.

## Como refazer, testar e verificar

```powershell
node scripts/embed-stt.mjs          # só se o runtime não existir (ou tiver sido reconstruído: isso apaga as bibliotecas de documentos)
node scripts/embed-office.mjs       # instala/atualiza as bibliotecas, a linha do ._pth e o MANIFEST; idempotente (--force reinstala; --check só confere, inclusive se o MANIFEST descreve os arquivos de hoje: rode sem --check depois de mexer em resources/office)
npx vitest run tests/office-runtime.test.ts tests/office-shell.test.ts tests/office-docs.test.ts tests/cowork-prompt.test.ts tests/skills.test.ts
npx electron-vite build --outDir "$env:TEMP\office-build"
node scripts/snapshot-app.cjs office --from "$env:TEMP\office-build"
node scripts/ui-cowork.cjs --scenario deliver --root <snapshot> --system-python nolibs   # modelo real; nolibs = Python do PC sem as bibliotecas; none = sem Python
```

- `tests/office-runtime.test.ts`: lógica do `PATH`, do `python` de reserva, da recusa de `pip` e da dica (pasta de recursos falsa, sem depender do runtime real).
- `tests/office-shell.test.ts`: o laço real do agente com o shell real: `openclod-python` com o Python do computador sem as bibliotecas e sem Python; `python` só redirecionado quando não há Python; dica; recusa do `pip` no Cowork e não no Code.
- `tests/path-env-expansion.test.ts`: o `%TEMP%` no começo de um caminho das ferramentas de arquivo.
- `tests/office-docs.test.ts`: as três receitas rodando no Python embutido, lidas de volta pelo `inspect` (valores em cache iguais ao que o Python calcula), abertas e recalculadas no LibreOffice quando ele existe, e os defeitos que o `inspect`/`recalc` precisam achar.
- `ui-cowork.cjs --scenario deliver` agora confere também: nenhum `pip install` executado, scripts rodados com `openclod-python`, as três skills carregadas, a pasta do usuário só com as entregas e o `.xlsx` recalculado pelo LibreOffice sem erro nem valor velho. As chamadas de ferramenta são lidas **ao vivo** (eventos `tool_start`/`tool_end`), porque uma conversa longa é compactada e a transcrição lida no fim perde as chamadas do começo. Opções novas do roteiro: `--system-python real|nolibs|none`, `--timeout-min`, `--ollama-fast`.

## Verificação com modelo real (27/out/2026)

O DeepSeek continua sem saldo (HTTP 402). O que foi tentado, por ordem:

| Rota | Resultado |
|---|---|
| `deepseek` | HTTP 402 `Insufficient Balance`. |
| `openrouter` e `opencode-go` do app | Sem chave no cofre real: a sessão fica `idle` com **0 mensagens** e a tela mostra "não tem credencial configurada" (isso **não** é resposta do modelo). |
| Modelos `openrouter/...:free` pelo Ollama local | `429 free-models-per-day` (o limite diário de requisições gratuitas da conta OpenRouter acabou); as versões pagas dos mesmos modelos não foram usadas (gastaria o dinheiro do usuário). |
| Modelos `:cloud` do Ollama | Caem no mesmo 402 do DeepSeek pela reserva de provedores. |
| `qwen3.5:4b` local | Responde, mas com o prompt inteiro a primeira chamada leva minutos (a janela de 262k estoura os 6 GB da GPU). Duas rodadas foram interrompidas por lentidão, uma delas por um erro do proxy de teste (corrigido em `scripts/lib/fake-provider.cjs`). |
| **`ollama` + `router/free`** | **Funcionou.** É o roteador do Ollama local sobre modelos gratuitos (inclui os `openrouter/...:free` e os de nuvem do Ollama); não dá para saber qual modelo respondeu a cada requisição. |

Rodadas do cenário `deliver` com `router/free`, `--system-python nolibs` (o `python` do PC sem as bibliotecas) e a pasta de vendas do estudo:

| Rodada | Resultado |
|---|---|
| 1 (receitas só como exemplo para copiar) | Não entregou: explorou as 60 iterações (leu as receitas, tentou `cat <<EOF` no `cmd`, `-c` de várias linhas) e parou com o plano bloqueado. **Motivou o caminho rápido de um comando** nas receitas e o aviso do `cmd.exe` nas skills. |
| 2 (caminho rápido) | 32/33: os três arquivos corretos em 211 s; a única falha era do roteiro (a compactação da conversa apagou do que ele lia as chamadas `use_skill`). Roteiro corrigido (eventos ao vivo). |
| 3 | **33/33** em 194 s. |
| Final, com o código final | **33/33 em 139 s** (provas em [`Prints/cowork-documentos-2026-10-27/`](../Prints/cowork-documentos-2026-10-27)): `relatorio-vendas.docx` (2 páginas), `analise-vendas.xlsx` (16 fórmulas, recalculadas no LibreOffice sem erro) e `apresentacao-vendas.pptx` (5 slides), receita total R$ 639.377 e as 3 regiões certas, o texto exigido pela pasta nos três, 12 comandos `openclod-python`, nenhum `pip`, as três skills carregadas, nada na pasta além das entregas. |

Limites desta prova: modelo desconhecido do roteador gratuito (não é o `deepseek-flash` do estudo), uma pasta de teste e quatro amostras; o que ela mostra é que o caminho funciona com um modelo real sem as bibliotecas no Python do PC, não que todo modelo o siga. **Repetir com o DeepSeek quando houver saldo**: `node scripts/ui-cowork.cjs --scenario deliver --root <snapshot> --system-python nolibs` (e `--system-python none` para um PC sem Python).

## Limites e cuidados

- Só Windows x64 (o runtime é o `python310` embutido). Em outras plataformas `officeRuntime()` devolve `null` e nada muda.
- O Python embutido não coloca a pasta do script no `sys.path`: um script que importa um irmão não funciona; escreva um arquivo só.
- O embutido não tem `pip`, de propósito. Para uma biblioteca fora desta lista (pandas, matplotlib) o modelo precisa pedir aprovação e usar o Python do computador.
- O `embed-stt.mjs` reconstrói o runtime inteiro quando suas entradas mudam: rode o `embed-office.mjs` depois (ele nota a falta e reinstala). `node scripts/embed-office.mjs --check` serve para CI.
- Skills empacotadas são copiadas uma vez para `%APPDATA%\Openclod Desktop\skills` e nunca sobrescritas: quem já tem uma pasta `docx`, `xlsx` ou `pptx` própria não recebe a nova. As três são novas, então os usuários atuais as recebem na próxima abertura.
- O Pillow traz FreeType, HarfBuzz, LittleCMS e libjpeg-turbo; o aviso completo vai em `resources/licenses/office/pillow/LICENSE`.
- Tamanho: ~25 MB descompactados no runtime (~12 MB a mais no instalador).
- `LibreOffice` é opcional (só `pdf` e `recalc` dependem dele); sem ele o `inspect` basta.
