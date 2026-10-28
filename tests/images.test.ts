import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editImage, generateImage, inspectImage } from '../src/core/images/service'
import { makeTempDir, removeTempDir } from './helpers'

describe('image tools', () => {
  let root: string
  beforeEach(async () => { root = await makeTempDir('openclod-images-') })
  afterEach(async () => {
    removeTempDir(root)
    vi.unstubAllGlobals()
    delete process.env.OPENCLOD_IMAGE_BASE_URL
  })

  it('inspects and edits images without overwriting the original', async () => {
    const input = path.join(root, 'source.png')
    const output = path.join(root, 'edited.webp')
    await sharp({ create: { width: 320, height: 180, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.8 } } }).png().toFile(input)
    const original = fs.readFileSync(input)
    expect(await inspectImage(input)).toMatchObject({ width: 320, height: 180, format: 'png', hasAlpha: true })
    const edited = await editImage({ input, output, crop: { left: 10, top: 20, width: 100, height: 80 }, width: 50, height: 50, rotate: 90, format: 'webp', quality: 75 })
    expect(edited).toMatchObject({ width: 50, height: 50, format: 'webp' })
    expect(fs.readFileSync(input)).toEqual(original)
    await expect(editImage({ input, output: input })).rejects.toThrow(/original/)
  })

  it('generates through an OpenAI-compatible endpoint and validates the image', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#e1a95f' } }).png().toBuffer()
    process.env.OPENCLOD_IMAGE_BASE_URL = 'http://images.local/v1'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const output = path.join(root, 'generated.png')
    const result = await generateImage({ prompt: 'um painel de controle', output })
    expect(result).toMatchObject({ path: output, width: 64, height: 64, format: 'png' })
    expect(fs.existsSync(output)).toBe(true)
  })

  it('fails clearly when no image provider is configured', async () => {
    await expect(generateImage({ prompt: 'teste', output: path.join(root, 'x.png') })).rejects.toThrow(/não configurada/)
  })
})
