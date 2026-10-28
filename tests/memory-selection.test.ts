import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, deletionText, masterState, prune, selectAll, selectRange, toggle } from '../src/renderer/src/lib/memory-selection'

// A tela de Memória ganhou uma caixa em cada card para apagar páginas em massa. Estas são as regras da seleção, sem a tela.
const order = ['a', 'b', 'c', 'd', 'e']
const names = (selection: { slugs: ReadonlySet<string> }): string[] => [...selection.slugs].sort()

describe('toggle', () => {
  it('marks and unmarks one page and remembers it as the anchor', () => {
    const one = toggle(EMPTY_SELECTION, 'b')
    expect(names(one)).toEqual(['b'])
    expect(one.anchor).toBe('b')
    const none = toggle(one, 'b')
    expect(names(none)).toEqual([])
    expect(none.anchor).toBe('b')
  })

  it('never changes the selection it was given', () => {
    const before = toggle(EMPTY_SELECTION, 'a')
    toggle(before, 'b')
    expect(names(before)).toEqual(['a'])
    expect(names(EMPTY_SELECTION)).toEqual([])
  })
})

describe('selectRange (Shift+click)', () => {
  it('marks every page between the anchor and the clicked one, in either direction', () => {
    expect(names(selectRange(toggle(EMPTY_SELECTION, 'b'), order, 'd'))).toEqual(['b', 'c', 'd'])
    expect(names(selectRange(toggle(EMPTY_SELECTION, 'd'), order, 'b'))).toEqual(['b', 'c', 'd'])
  })

  it('keeps what was already marked and moves the anchor to the clicked page', () => {
    const start = toggle(toggle(EMPTY_SELECTION, 'a'), 'c')
    const ranged = selectRange(start, order, 'e')
    expect(names(ranged)).toEqual(['a', 'c', 'd', 'e'])
    expect(ranged.anchor).toBe('e')
  })

  it('without an anchor, or with an anchor that left the list, is a plain click', () => {
    expect(names(selectRange(EMPTY_SELECTION, order, 'c'))).toEqual(['c'])
    expect(names(selectRange({ slugs: new Set(['x']), anchor: 'x' }, order, 'c'))).toEqual(['c', 'x'])
  })
})

describe('selectAll, prune and masterState', () => {
  it('selects the whole visible list', () => {
    expect(names(selectAll(order))).toEqual(order)
    expect(selectAll(order).anchor).toBeNull()
  })

  it('drops what is no longer in the list (a search narrowed it, a page was deleted) and keeps the same object when nothing changed', () => {
    const all = selectAll(order)
    expect(prune(all, order)).toBe(all)
    const narrowed = prune(toggle(all, 'e'), ['a', 'b', 'c'])
    expect(names(narrowed)).toEqual(['a', 'b', 'c'])
    expect(narrowed.anchor).toBeNull() // the anchor ('e') left the list
    expect(names(prune(all, ['b', 'd']))).toEqual(['b', 'd'])
    expect(prune(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION)
    expect(prune(toggle(EMPTY_SELECTION, 'b'), order).anchor).toBe('b')
  })

  it('tells none, some and all for the master box', () => {
    expect(masterState(0, 5)).toBe('none')
    expect(masterState(2, 5)).toBe('some')
    expect(masterState(5, 5)).toBe('all')
    expect(masterState(0, 0)).toBe('none')
    expect(masterState(3, 0)).toBe('none')
  })
})

describe('the words of the delete button and of its confirmation', () => {
  it('counts the pages and says how many are pinned, in the singular and in the plural', () => {
    expect(deletionText(1, 0)).toEqual({ button: 'Apagar 1', confirm: 'Confirmar: apagar 1 página' })
    expect(deletionText(12, 0).confirm).toBe('Confirmar: apagar 12 páginas')
    expect(deletionText(12, 1).confirm).toBe('Confirmar: apagar 12 páginas (1 fixada)')
    expect(deletionText(12, 3).confirm).toBe('Confirmar: apagar 12 páginas (3 fixadas)')
  })
})
