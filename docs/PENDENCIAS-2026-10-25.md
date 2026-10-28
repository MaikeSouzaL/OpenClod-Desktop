# Estado das pendências — 2026-10-25

## Validação real

- **OpenCode Go:** credencial importada para o cofre DPAPI do aplicativo. Teste
  real pelo caminho do Openclod: modelo `beam-free`, resposta `pong`, uso
  `input 63 / output 38`.
- **Build:** `npm run build` passou. Typecheck dos dois projetos passou.
- **Computer Use:** matriz real de todas as janelas disponíveis no teste, com **50
  operações, 46 sucessos, 4 limitações explícitas e 0 falhas inesperadas**. Inclui captura, UIA, teclado, mouse,
  rolagem, arrasto, espera e captura de desktop.
- **Snapshot stale:** `ref + snapshot_id` é rejeitado quando o snapshot mudou;
  árvores de acessibilidade acima do limite são truncadas com marcador.
- **Percepção visual:** a mesma matriz gravou 27 PNGs, incluindo a tela completa
  e todas as janelas inspecionadas.
- **Chrome existente:** host nativo e atalho da extensão instalados. O serviço
  de ponte inicia e informa `attached: false` até o Chrome carregar a extensão
  unpacked. Essa confirmação é uma ação do próprio navegador.
- **PrintClaude:** 107 capturas do Claude Desktop copiadas para
  `PrintClaude/`, com índice em `PrintClaude/INDICE-TELAS.md`.
- **Memória:** Importar, exportar, pasta e Importar ZIP estão na mesma tela.
  O grafo usa links `[[...]]`, tags e termos, com nó clicável.
- **Instalador:** `npm run dist` gerou
  `release/Openclod Desktop-0.1.0-setup.exe` (840.915.527 bytes), incluindo
  `open-computer-use.exe`, `openclod-chrome-host.exe`, `rg.exe` e
  `ai-memory.exe`. SHA-256:
  `71A87483CC9585DD37567BC040673C50DFCEA3D090CFA6825AB9EE92DA3389DC`.
- **Suíte completa:** 51 arquivos, **801 testes aprovados**. Typecheck, build,
  audit e smoke passaram depois de todas as mudanças desta jornada.
- **Segurança de dependências:** `npm audit` com 0 vulnerabilidades; Zod 4.6.7,
  Sharp 0.35.5 e Vitest 5.0.5.
- **Voz neural:** Edge Neural TTS gratuito integrado ao botão de leitura, com 316
  vozes online, três opções pt-BR e fallback offline para o Windows. O E2E gerou,
  decodificou e reproduziu o MP3 pelo próprio transcript.
- **Novos módulos reais:** backup com pré-restauração, diagnóstico, configuração
  portátil, documentos, áudio/vídeo, OCR nativo, imagens, TTS, notificações,
  memória com proveniência/conflitos, plugins locais, updater, retry/histórico no
  scheduler e benchmarks com limite do grafo.
- **Desempenho:** grafo de 1.000 páginas passou de 499.500 para 6.071 arestas,
  de 943 para 314 ms e heap observado de 93 para 14 MB.
- **OpenCode externo:** executor real validado com `opencode/beam-free`; a
  resposta foi `PONG`, com sessão e uso informados pelo próprio CLI.
- **Worktrees:** fluxo real no Electron criou uma branch e uma sessão isolada,
  confirmou o `projectId` e removeu o checkout sem apagar a branch. Evidência em
  `Prints/worktrees-2026-10-25/`.
- **MCP:** ferramentas, recursos e prompts são descobertos com paginação e
  expostos por `mcp_resource`/`mcp_prompt`; o painel mostra as três contagens.
- **Slides:** editor visual com tamanho, duplicação, reordenação, exclusão,
  apresentação e exportação HTML verificados no Electron.
- **Ambientes:** o seletor Local/WSL/SSH/Nuvem está ligado ao roteamento real;
  WSL exige virtualização ativa e SSH/Nuvem exigem um destino configurado.
- **Repositórios:** 55/55 checkouts válidos, com inventário de commits,
  licenças, linguagens e módulos candidatos em
  `docs/research/REPOSITORY_INVENTORY_2026-10-25.md`.
- **Rewind e revisão:** conversa pode ser truncada ou ramificada; comentários
  de diff persistem e podem ser copiados para o agente.
- **Pacote real:** `scripts/smoke-packaged.cjs` abriu o renderer de
  `release/win-unpacked` com perfil descartável.

## Limites externos registrados

- O Claude Desktop instalado via MSIX não abriu uma janela na sessão desta
  rodada depois de ser encerrado. As capturas anteriores foram conservadas e
  usadas para a comparação visual.
- A extensão do Openclod não aparece como conectada até ser carregada em
  `chrome://extensions/` com **Desenvolvedor** e **Carregar sem compactação**.
  A pasta já está preparada no atalho
  `Desktop/Openclod - Carregar extensão no Chrome.lnk`.
- OAuth MCP: o fluxo DCR + PKCE está implementado e validado contra os metadados
  reais do Atlassian (PRM com 40 escopos, authorization server do tenant, DCR
  respondendo 201 e authorization endpoint redirecionando para o login). Falta
  concluir um consentimento real com uma conta Atlassian nesta máquina. O
  conector Mercado Pago testado rejeitou DCR; para ele, use token estático ou
  outro provedor.
- O feed público do updater ainda não existe; verificação e download foram
  testados com manifesto local e checksum SHA-256.
- O runtime de plugins locais cobre ferramentas e skills. Comandos, hooks
  executáveis, provedores e páginas visuais de terceiros continuam pendentes.

## Reprodução rápida

```powershell
npm run typecheck
npx vitest run
npm run build
npx esbuild scripts/computer-use-live.ts --bundle --platform=node --format=cjs --outfile=.qa/computer-use-live.cjs
node .qa/computer-use-live.cjs
node scripts/install-chrome-companion.mjs
node scripts/ui-worktrees.cjs
npx vitest run tests/mcp.test.ts tests/mcp-tools.test.ts
npx vitest run tests/slides.test.ts tests/environments.test.ts tests/rewind.test.ts
node scripts/ui-slides.cjs
node scripts/smoke-packaged.cjs
```
