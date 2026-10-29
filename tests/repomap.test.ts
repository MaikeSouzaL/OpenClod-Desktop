import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pageRank, rankDefinitions, repoMap } from '../src/core/code-intelligence/repomap'

let root = ''
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-repomap-'))
  write('src/store.ts', 'export class SessionStore {\n  load() {}\n}\n')
  write('src/util.ts', 'export function formatDuration(ms: number): string {\n  return `${ms}`\n}\n/** the function that nobody calls */\nfunction privateHelper() {}\n')
  write('src/lonely.ts', 'export const lonelyThing = () => 1\n')
  write('src/special.ts', 'export function specialThing(): number {\n  return 1\n}\n')
  write('src/a.ts', "import { SessionStore } from './store'\nimport { formatDuration } from './util'\nconst store = new SessionStore()\nformatDuration(1)\n")
  write('src/b.ts', "import { SessionStore } from './store'\nexport const second = new SessionStore()\n")
  write('src/c.ts', "import { SessionStore } from './store'\nexport const third = new SessionStore()\n")
  write('src/d.ts', "import { specialThing } from './special'\nspecialThing()\n")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('pageRank', () => {
  it('sends rank to the nodes others point at, and keeps the total', () => {
    const rank = pageRank(3, [
      [0, 2, 1],
      [1, 2, 1]
    ])
    expect(rank[2]).toBeGreaterThan(rank[0])
    expect(rank.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6)
    // Teleporting to node 0 only: what node 0 points at gains the most.
    const focused = pageRank(3, [[0, 1, 1], [2, 1, 1]], [1, 0, 0])
    expect(focused[1]).toBeGreaterThan(focused[2])
  })
})

describe('repo map', () => {
  it('ranks what the rest of the code uses above what nobody uses, and skips comments', async () => {
    const { ranked, files } = await rankDefinitions(root)
    expect(files).toBe(8)
    const names = ranked.map((def) => def.name)
    expect(names[0]).toBe('SessionStore')
    expect(names.indexOf('formatDuration')).toBeLessThan(names.indexOf('lonelyThing'))
    // "the function that nobody calls" is a comment, not a function named "that".
    expect(names).not.toContain('that')
  })

  it('pulls the definitions the focused file uses to the top', async () => {
    const { ranked } = await rankDefinitions(root, { focus: ['src/d.ts'] })
    expect(ranked[0].name).toBe('specialThing')
    const mentioned = await rankDefinitions(root, { mentions: ['formatDuration'] })
    expect(mentioned.ranked.findIndex((def) => def.name === 'formatDuration')).toBeLessThanOrEqual(1)
  })

  it('renders file by file within the token budget', async () => {
    const map = await repoMap(root, { maxTokens: 200 })
    expect(map.tokens).toBeLessThanOrEqual(200)
    expect(map.text).toContain('src/store.ts:\n│ 1: export class SessionStore {\n⋮')
    const small = await repoMap(root, { maxTokens: 200, focus: ['src/d.ts'] })
    expect(small.shown).toBeGreaterThan(0)
  })
})
