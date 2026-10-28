import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transcribeMedia } from '../src/core/media/transcribe'
import { makeTempDir, removeTempDir } from './helpers'

describe('media transcription', () => {
  let root: string
  beforeEach(async () => { root = await makeTempDir('openclod-media-') })
  afterEach(async () => removeTempDir(root))

  it('rejects unsupported files before starting Whisper', async () => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'not media')
    await expect(transcribeMedia(file)).rejects.toThrow(/não suportado/)
  })

  it('reports a missing Whisper model', async () => {
    const file = path.join(root, 'audio.wav')
    fs.writeFileSync(file, Buffer.alloc(44))
    await expect(transcribeMedia(file, { model: 'missing' })).rejects.toThrow(/modelo Whisper não encontrado/)
  })
})
