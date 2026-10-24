# qa-total dentro do Openclod Desktop

Esta skill foi copiada do acervo do usuário e é usada pelo agente `qa-lead`.

## Como o agente deve usá-la

1. `use_skill` com o nome `qa-total` para carregar o método completo.
2. O caminho desta pasta aparece no retorno da skill. No Windows, os scripts
   ficam em `<pasta-da-skill>\scripts`.
3. Rode os scripts com o Python disponível no sistema (`python`), a partir da
   raiz do projeto testado:
   - `python <skill>\scripts\cobertura.py init ...`
   - `python <skill>\scripts\executar_caso.py ...`
   - `python <skill>\scripts\gerar_pdf.py ...`
4. Use `computer_*` para provas visuais no Windows real, `browser_*` para web e
   `adb` para Android/Expo/React Native.

## Diferenças em relação ao Claude Code

- Aqui o agente pode operar o computador inteiro (mouse, teclado, janelas,
  PowerShell/cmd) e instalar MCPs sozinho (`mcp_search`, `mcp_install`).
- O ledger `.qa/` continua sendo criado na raiz do projeto testado.
- Evidências podem ser prints do próprio Windows (`computer_screenshot`) ou do
  navegador (`browser_screenshot`), além dos scripts da skill.
- O gate continua obrigatório: nada de declarar "pronto" com caso pendente.
