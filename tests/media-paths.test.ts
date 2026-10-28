import { describe, expect, it } from 'vitest'
import { findMediaPaths } from '../src/core/media/paths'
import { mediaKindOf } from '../src/core/media/ingest'

describe('which files count as media', () => {
  it('knows audio and video by extension, case-insensitively, and nothing else', () => {
    expect(mediaKindOf('C:\\v\\aula.MP4')).toBe('video')
    expect(mediaKindOf('reuniao.mkv')).toBe('video')
    expect(mediaKindOf('voz.wav')).toBe('audio')
    expect(mediaKindOf('podcast.mp3')).toBe('audio')
    // .ts is TypeScript here, not a transport stream
    expect(mediaKindOf('index.ts')).toBeNull()
    expect(mediaKindOf('notas.txt')).toBeNull()
    expect(mediaKindOf('sem-extensao')).toBeNull()
  })
})

describe('media paths in what the user typed or attached', () => {
  it('takes the paths of the attachment block, written between backticks', () => {
    const text = [
      'resuma este vídeo',
      '',
      'Pastas e arquivos anexados pelo usuário (leia pelos caminhos):',
      '- arquivo "reuniao q3.mp4": `C:\\Users\\Administrator\\Downloads\\reuniao q3.mp4`',
      '- arquivo "notas.txt": `C:\\Users\\Administrator\\Downloads\\notas.txt`'
    ].join('\n')
    expect(findMediaPaths(text)).toEqual(['C:\\Users\\Administrator\\Downloads\\reuniao q3.mp4'])
  })

  it('takes quoted and bare paths, spaces included, and drops the punctuation that ends a sentence', () => {
    expect(findMediaPaths('veja "D:\\Vídeos\\minha aula.webm" e me diga')).toEqual(['D:\\Vídeos\\minha aula.webm'])
    expect(findMediaPaths('transcreve C:\\audios\\recado de voz.m4a por favor')).toEqual(['C:\\audios\\recado de voz.m4a'])
    expect(findMediaPaths('o arquivo é C:\\tmp\\gravacao.wav.')).toEqual(['C:\\tmp\\gravacao.wav'])
    expect(findMediaPaths('(C:\\tmp\\a.mp3), depois C:\\tmp\\b.flac!')).toEqual(['C:\\tmp\\a.mp3', 'C:\\tmp\\b.flac'])
  })

  it('does not repeat a path and stops at the limit', () => {
    const text = '`C:\\a\\1.mp4` e C:\\a\\1.mp4 de novo, `C:\\a\\2.mp4` `C:\\a\\3.mp4` `C:\\a\\4.mp4`'
    expect(findMediaPaths(text)).toEqual(['C:\\a\\1.mp4', 'C:\\a\\2.mp4', 'C:\\a\\3.mp4'])
    expect(findMediaPaths(text, 2)).toHaveLength(2)
    expect(findMediaPaths('`C:\\A\\X.MP4` c:\\a\\x.mp4')).toHaveLength(1)
  })

  it('ignores what is not an absolute path to audio or video', () => {
    expect(findMediaPaths('nada aqui')).toEqual([])
    expect(findMediaPaths('abra src\\index.ts e `C:\\proj\\notas.txt`')).toEqual([])
    expect(findMediaPaths('o vídeo.mp4 relativo não conta')).toEqual([])
    expect(findMediaPaths('https://site.com/aula.mp4')).toEqual([])
    expect(findMediaPaths('`\\\\servidor\\pasta\\a.mp4`')).toEqual([])
  })
})
