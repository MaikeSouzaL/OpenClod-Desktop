import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Dictation } from '../src/core/util/dictation'
import { discoverSttModels } from '../src/main/stt'

describe('Dictation text assembly', () => {
  it('replaces partials, appends finals and keeps what the user typed', () => {
    const dictation = new Dictation('Antes:')
    expect(dictation.setPartial('abre o arquivo')).toBe('Antes: abre o arquivo')
    expect(dictation.setPartial('abra o arquivo readme')).toBe('Antes: abra o arquivo readme')
    expect(dictation.addFinal('Abra o arquivo readme.')).toBe('Antes: Abra o arquivo readme.')
    expect(dictation.setPartial('e rode')).toBe('Antes: Abra o arquivo readme. e rode')
    expect(dictation.addFinal('E rode os testes.')).toBe('Antes: Abra o arquivo readme. E rode os testes.')
  })

  it('detects manual edits and rebases on them', () => {
    const dictation = new Dictation('')
    dictation.setPartial('texto parcial')
    expect(dictation.diverged('texto parcial')).toBe(false)
    expect(dictation.diverged('outra coisa')).toBe(true)
    dictation.rebase('outra coisa')
    expect(dictation.addFinal('final')).toBe('outra coisa final')
  })

  it('ignores an empty final and an empty partial', () => {
    const dictation = new Dictation('base')
    expect(dictation.addFinal('   ')).toBe('base')
    expect(dictation.setPartial('')).toBe('base')
  })
})

describe('Whisper model discovery', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function fixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-stt-models-'))
    dirs.push(dir)
    for (const [id, size, meta] of [
      ['base', 1024, { id: 'base' }],
      ['tiny', 512, { id: 'tiny' }],
      ['broken', 0, null]
    ] as const) {
      const folder = path.join(dir, id)
      fs.mkdirSync(folder)
      if (meta) fs.writeFileSync(path.join(folder, 'forja-model.json'), JSON.stringify(meta))
      if (size > 0) fs.writeFileSync(path.join(folder, 'model.bin'), Buffer.alloc(size))
    }
    fs.mkdirSync(path.join(dir, 'sem-pesos'))
    return dir
  }

  it('lists only folders with weights, smallest first', () => {
    const models = discoverSttModels(fixture())
    expect(models.map((model) => model.id)).toEqual(['tiny', 'base'])
    expect(models[0].sizeMB).toBe(0)
  })

  it('returns an empty list for a missing directory', () => {
    expect(discoverSttModels(path.join(os.tmpdir(), 'forja-nao-existe-123'))).toEqual([])
    expect(discoverSttModels(null)).toEqual([])
  })
})
