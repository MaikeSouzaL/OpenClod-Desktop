import { describe, expect, it } from 'vitest'
import { detectRepetition } from '../src/core/agent/loop-detection'

describe('loop detection', () => {
  it('catches a long paragraph repeated in the reasoning', () => {
    const block = 'Preciso verificar a hipótese com cuidado antes de responder ao usuário. '
    const text = block.repeat(6)
    expect(detectRepetition(text)).toMatchObject({ repeats: 6 })
  })

  it('catches a short sentence repeated line by line', () => {
    const line = 'Vou tentar a mesma abordagem novamente.'
    const text = Array.from({ length: 6 }, () => line).join('\n')
    expect(detectRepetition(text)).toMatchObject({ repeats: 6, kind: 'line' })
  })

  it('catches a repeated loop even with a distinct introduction', () => {
    const introduction = 'O problema é o seguinte: preciso decidir entre duas alternativas e registrar a escolha. '
    const block = 'A janela deslizante precisa reprocessar o áudio recente e comparar o texto com o que já foi ditado. '
    const text = introduction + block.repeat(5)
    expect(detectRepetition(text)).not.toBeNull()
  })

  it('does not flag normal prose', () => {
    const text =
      'O usuário pediu para investigar o erro de áudio. Primeiro vou ler o arquivo de configuração. ' +
      'Depois comparo a saída do Whisper com o texto do compositor. Se o problema estiver no corte de palavras, ' +
      'vou ajustar a janela e repetir o teste. Caso contrário, verifico o backend CUDA e o modelo.'
    expect(detectRepetition(text)).toBeNull()
  })

  it('ignores very short texts', () => {
    expect(detectRepetition('repete repete repete')).toBeNull()
  })
})
