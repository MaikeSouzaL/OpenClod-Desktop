/**
 * Seleção de páginas na tela de Memória (marcar vários cards e apagar em massa). Conjuntos que nunca mudam por dentro e funções
 * puras, para testar sem a tela.
 */

export interface Selection {
  slugs: ReadonlySet<string>
  /** A última página marcada ou desmarcada: de onde parte o Shift+clique. */
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { slugs: new Set<string>(), anchor: null }

/** Liga ou desliga uma página. */
export function toggle(selection: Selection, slug: string): Selection {
  const slugs = new Set(selection.slugs)
  if (slugs.has(slug)) slugs.delete(slug)
  else slugs.add(slug)
  return { slugs, anchor: slug }
}

/** Shift+clique: marca as páginas entre a âncora e `slug`, na ordem em que aparecem. Sem âncora (ou fora da lista) é um clique comum. */
export function selectRange(selection: Selection, order: readonly string[], slug: string): Selection {
  const to = order.indexOf(slug)
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor)
  if (to < 0 || from < 0) return toggle(selection, slug)
  const slugs = new Set(selection.slugs)
  for (const item of order.slice(Math.min(from, to), Math.max(from, to) + 1)) slugs.add(item)
  return { slugs, anchor: slug }
}

export function selectAll(order: readonly string[]): Selection {
  return { slugs: new Set(order), anchor: null }
}

/** Tira da seleção o que saiu da lista (a busca mudou, a página foi apagada). Devolve o mesmo objeto quando nada mudou. */
export function prune(selection: Selection, order: readonly string[]): Selection {
  if (!selection.slugs.size) return selection
  const visible = new Set(order)
  const kept = [...selection.slugs].filter((slug) => visible.has(slug))
  if (kept.length === selection.slugs.size) return selection
  return { slugs: new Set(kept), anchor: selection.anchor !== null && visible.has(selection.anchor) ? selection.anchor : null }
}

export type MasterState = 'none' | 'some' | 'all'

/** O estado da caixa "Selecionar todas": nenhuma, algumas (traço) ou todas as páginas da lista. */
export function masterState(selected: number, total: number): MasterState {
  if (!selected || !total) return 'none'
  return selected >= total ? 'all' : 'some'
}

/** Os textos do botão de apagar e da confirmação em dois cliques: contam as páginas e dizem quantas estão fixadas. */
export function deletionText(count: number, pinned: number): { button: string; confirm: string } {
  const noun = count === 1 ? 'página' : 'páginas'
  const pins = pinned ? ` (${pinned} ${pinned === 1 ? 'fixada' : 'fixadas'})` : ''
  return { button: `Apagar ${count}`, confirm: `Confirmar: apagar ${count} ${noun}${pins}` }
}
