// Escreve src/renderer/src/lib/provider-logos.ts: as marcas dos provedores (Configurações → Provedores) como caminhos SVG embutidos.
//
//   node scripts/provider-logos.mjs
//
// Origem: o pacote `simple-icons` (coleção CC0; cada marca pertence ao seu dono, veja THIRD_PARTY_NOTICES.md §5) e, para o que ele
// já não traz (OpenAI), o caminho guardado abaixo com a sua origem. Nada é baixado em tempo de execução. Os logos da Anthropic/Claude
// NÃO entram (THIRD_PARTY_NOTICES.md §5): esses provedores mostram as iniciais.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = path.join(ROOT, 'node_modules', 'simple-icons')
const OUT = path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'provider-logos.ts')

/** id do provedor no app → etiqueta no simple-icons. `colored`: a marca mantém a cor oficial; as demais usam a cor do texto do tema. */
export const FROM_SIMPLE_ICONS = {
  colab: { slug: 'googlecolab', colored: true },
  deepseek: { slug: 'deepseek', colored: true },
  qwen: { slug: 'qwen', colored: true },
  openrouter: { slug: 'openrouter', colored: true },
  ollama: { slug: 'ollama' },
  lmstudio: { slug: 'lmstudio' },
  kimi: { slug: 'kimi' },
  opencode: { slug: 'opencode' },
  'opencode-go': { slug: 'opencode' }
}

/**
 * OpenAI: o simple-icons deixou de distribuir esta marca. O caminho (viewBox 24, regra evenodd) vem do arquivo
 * `docs/images/provider-icons/openai.svg` do repositório mem0ai/mem0 (Apache-2.0), já clonado em
 * `repositorios/_research/memory/mem0ai--mem0/`. Marca registrada da OpenAI, usada só para identificar o provedor.
 */
export const OPENAI_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z'

function readMark(slug) {
  const svg = fs.readFileSync(path.join(PACKAGE, 'icons', `${slug}.svg`), 'utf8')
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1]
  const d = / d="([^"]+)"/.exec(svg)?.[1]
  if (!viewBox || !d || / d="[^"]+"[^]* d="/.test(svg)) throw new Error(`${slug}.svg: esperava um viewBox e um único caminho`)
  return { viewBox, path: d }
}

export function buildMarks() {
  const meta = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'data', 'simple-icons.json'), 'utf8'))
  const version = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version
  const marks = {}
  for (const [id, { slug, colored }] of Object.entries(FROM_SIMPLE_ICONS)) {
    const row = meta.find((item) => item.slug === slug)
    if (!row) throw new Error(`simple-icons não tem "${slug}"`)
    marks[id] = { ...readMark(slug), ...(colored ? { color: `#${row.hex}` } : {}), from: `simple-icons ${version} · ${slug}` }
  }
  marks.openai = { viewBox: '0 0 24 24', path: OPENAI_PATH, fillRule: 'evenodd', from: 'mem0ai/mem0 · docs/images/provider-icons/openai.svg' }
  return { marks, version }
}

export function render({ marks, version }) {
  const lines = Object.entries(marks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, mark]) => {
      const parts = [`viewBox: '${mark.viewBox}'`, `path: '${mark.path}'`]
      if (mark.fillRule) parts.push(`fillRule: '${mark.fillRule}'`)
      if (mark.color) parts.push(`color: '${mark.color}'`)
      return `  // ${mark.from}\n  '${id}': { ${parts.join(', ')} }`
    })
  return `/* GERADO por scripts/provider-logos.mjs (simple-icons ${version}). Não edite à mão. */
/* Marcas registradas dos respectivos donos, usadas só para identificar o provedor (THIRD_PARTY_NOTICES.md §5). Sem Anthropic/Claude. */

export interface ProviderMark {
  viewBox: string
  path: string
  fillRule?: 'evenodd'
  /** Cor oficial da marca; sem ela o desenho usa a cor do texto do tema. */
  color?: string
}

export const PROVIDER_MARKS: Record<string, ProviderMark> = {
${lines.join(',\n')}
}
`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, render(buildMarks()), 'utf8')
  console.log(`escrito ${path.relative(ROOT, OUT)}`)
}
