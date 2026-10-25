# Estado das pendências — 2026-10-25

## Validação real

- **OpenCode Go:** credencial importada para o cofre DPAPI do aplicativo. Teste
  real pelo caminho do Openclod: modelo `beam-free`, resposta `pong`, uso
  `input 63 / output 38`.
- **Build:** `npm run build` passou. Typecheck dos dois projetos passou.
- **Computer Use:** matriz real em Bloco de Notas com **35 sucessos, 5 falhas
  esperadas e 0 falhas inesperadas**. Inclui captura, UIA, teclado, mouse,
  rolagem, arrasto, espera e captura de desktop.
- **Snapshot stale:** `ref + snapshot_id` é rejeitado quando o snapshot mudou;
  árvores de acessibilidade acima do limite são truncadas com marcador.
- **Chrome existente:** host nativo e atalho da extensão instalados. O serviço
  de ponte inicia e informa `attached: false` até o Chrome carregar a extensão
  unpacked. Essa confirmação é uma ação do próprio navegador.
- **PrintClaude:** 107 capturas do Claude Desktop copiadas para
  `PrintClaude/`, com índice em `PrintClaude/INDICE-TELAS.md`.
- **Memória:** Importar, exportar, pasta e Importar ZIP estão na mesma tela.
  O grafo usa links `[[...]]`, tags e termos, com nó clicável.
- **Instalador:** `npm run dist` gerou
  `release/Openclod Desktop-0.1.0-setup.exe` (833.030.370 bytes), incluindo
  `open-computer-use.exe` e `openclod-chrome-host.exe`.
- **Suíte completa:** 35 arquivos, **743 testes aprovados**. Depois das
  últimas mudanças, o build e os testes focados (40/40) passaram novamente.

## Limites externos registrados

- O Claude Desktop instalado via MSIX não abriu uma janela na sessão desta
  rodada depois de ser encerrado. As capturas anteriores foram conservadas e
  usadas para a comparação visual.
- A extensão do Openclod não aparece como conectada até ser carregada em
  `chrome://extensions/` com **Desenvolvedor** e **Carregar sem compactação**.
  A pasta já está preparada no atalho
  `Desktop/Openclod - Carregar extensão no Chrome.lnk`.
- O OAuth MCP exige um provedor que aceite registro dinâmico de cliente ou um
  `client_id` já registrado; o conector Mercado Pago testado rejeitou DCR.

## Reprodução rápida

```powershell
npm run typecheck
npx vitest run
npm run build
npx esbuild scripts/computer-use-live.ts --bundle --platform=node --format=cjs --outfile=.qa/computer-use-live.cjs
node .qa/computer-use-live.cjs
node scripts/install-chrome-companion.mjs
```
