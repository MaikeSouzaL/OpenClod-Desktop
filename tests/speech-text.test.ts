import { describe, expect, it } from 'vitest'
import { SPEECH_FALLBACK, speechText } from '../src/renderer/src/lib/speech'

/**
 * The "Ler em voz alta" button must speak what the screen shows, not the markdown source: the user heard
 * "asterisco asterisco", the backticks and the dashes, plus things that are not on screen at all.
 */
describe('speech text', () => {
  it('drops the markdown markers of the answer the user complained about and keeps what is shown', () => {
    const answer = [
      'Olá!',
      '',
      'Estado agora:',
      '',
      '- **MCP do Jira**: conectado (`jira · ready · 38 ferramentas`, read-only) e já retornando dados do CNC.',
      '- **Backlog**: próximos pela ordem são **CNC-113 Desenho: Combustíveis** e **CNC-114 Código: Combustíveis**.',
      '- **Harness**: o teste de mouse passou duas vezes.',
      '',
      'Quer que eu abra a CNC-113 pelo MCP, ou prefere outra coisa?'
    ].join('\n')
    const spoken = speechText(answer)
    expect(spoken).not.toMatch(/\*|`|^-|#/m)
    expect(spoken.split('\n')).toEqual([
      'Olá!',
      'Estado agora:',
      'MCP do Jira: conectado (jira, ready, 38 ferramentas, read-only) e já retornando dados do CNC.',
      'Backlog: próximos pela ordem são CNC-113 Desenho: Combustíveis e CNC-114 Código: Combustíveis.',
      'Harness: o teste de mouse passou duas vezes.',
      'Quer que eu abra a CNC-113 pelo MCP, ou prefere outra coisa?'
    ])
  })

  it('reads headings, emphasis, strikethrough and quotes without their symbols', () => {
    const spoken = speechText('# Título\n\n## Subtítulo grande\n\n> citação **forte** com _ênfase_ e ~~riscado~~\n\n---\n\nfim')
    expect(spoken.split('\n')).toEqual(['Título.', 'Subtítulo grande.', 'citação forte com ênfase e riscado.', 'fim.'])
  })

  it('numbers an ordered list from where it starts and does not read the bullets or the task boxes', () => {
    const spoken = speechText('3. primeiro passo\n4. segundo passo\n\n- [x] feito\n- [ ] por fazer\n  - aninhado')
    expect(spoken.split('\n')).toEqual(['3, primeiro passo.', '4, segundo passo.', 'feito.', 'por fazer.', 'aninhado.'])
  })

  it('reads the label of a link, only the site of an address, and nothing for an image', () => {
    const spoken = speechText('Veja [a documentação](https://docs.exemplo.com/guia/instalar?x=1) e https://www.github.com/org/repo/issues/9 ![logo](a.png).')
    expect(spoken).toBe('Veja a documentação e github.com.')
    expect(spoken).not.toMatch(/https?:|\/|\?/)
    expect(speechText('[https://mcp.atlassian.com/v2/mcp](https://mcp.atlassian.com/v2/mcp)')).toBe('mcp.atlassian.com.')
    expect(speechText('o endereço é `https://mcp.atlassian.com/v2/mcp` mesmo')).toBe('o endereço é mcp.atlassian.com mesmo.')
  })

  it('reads a table row by row, with no pipes or dashes', () => {
    const spoken = speechText('| Servidor | Estado |\n|---|---|\n| jira | pronto |\n| rea | erro |')
    expect(spoken.split('\n')).toEqual(['Servidor, Estado.', 'jira, pronto.', 'rea, erro.'])
  })

  it('does not read code, but reads a reply drafted inside a plain fence', () => {
    expect(speechText('Rode:\n\n```bash\nnpm run build\n```\n\ne depois:\n\n```ts\nconst a = 1\n```')).toBe('Rode:\ne depois:')
    expect(speechText('Segue a resposta para o cliente:\n\n```\nOlá, tudo bem? Seu pedido saiu hoje.\n\nQualquer dúvida, é só chamar.\n```')).toBe(
      'Segue a resposta para o cliente:\nOlá, tudo bem? Seu pedido saiu hoje.\nQualquer dúvida, é só chamar.'
    )
    expect(speechText('```\n{ "a": [1, 2, 3], "b": { "c": null } }\n```')).toBe('')
  })

  it('skips a drawing, which is a picture on screen, fenced or not', () => {
    const svg = '<svg viewBox="0 0 10 10"><text x="1" y="5">legenda</text><circle cx="5" cy="5" r="3"/></svg>'
    expect(speechText(`Aqui está o desenho:\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nPronto.`)).toBe('Aqui está o desenho:\nPronto.')
    expect(speechText(`Veja:\n${svg}\nPronto.`)).toBe('Veja:\nPronto.')
    expect(speechText(`\`\`\`svg\n${svg}\n\`\`\``)).toBe('')
  })

  it('shows entities as the screen does and keeps visible html text without the tags', () => {
    expect(speechText('Tom &amp; Jerry &lt;3 &#233;')).toBe('Tom & Jerry <3 é.')
    expect(speechText('<div class="x">oi <b>mundo</b></div>\n\ntexto')).toBe('oi mundo.\ntexto.')
    expect(speechText('linha um<br>linha dois')).toBe('linha um.\nlinha dois.')
    expect(speechText('<script>alert(1)</script>depois')).toBe('depois.')
  })

  it('turns the dots and arrows used as separators into pauses, and drops emoji', () => {
    expect(speechText('Personalização → Conectores · 11 conectados 🎉✅')).toBe('Personalização, Conectores, 11 conectados.')
  })

  it('keeps single line breaks as separate sentences, like the screen does', () => {
    expect(speechText('primeira linha\nsegunda linha').split('\n')).toEqual(['primeira linha.', 'segunda linha.'])
  })

  it('returns nothing for an answer with nothing to read, and the fallback line says why', () => {
    expect(speechText('')).toBe('')
    expect(speechText('   \n\n  ')).toBe('')
    expect(speechText('```js\nconsole.log(1)\n```')).toBe('')
    expect(SPEECH_FALLBACK).toContain('código')
  })

  it('stays under the size the voice accepts and cuts at the end of a sentence', () => {
    const long = Array.from({ length: 3000 }, (_, index) => `Esta é a frase número ${index}.`).join(' ')
    const spoken = speechText(long)
    expect(spoken.length).toBeLessThanOrEqual(18_000)
    expect(spoken.length).toBeGreaterThan(9_000)
    expect(spoken.endsWith('.')).toBe(true)
  })
})
