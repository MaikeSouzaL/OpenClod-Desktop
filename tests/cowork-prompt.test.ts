import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/agent/context'
import { policy } from './helpers'

// What the Cowork surface tells the model to do about the user's own folder, about checking its work and about installing
// software. These came out of real runs: a three-file job left ~40 helper files in the folder, a "look at the result" step took a
// screenshot of the whole desktop, and a missing Python module was pip-installed on the user's machine without asking.

const base = {
  mode: 'autonomous' as const,
  cwd: 'C:\\Users\\ana\\Documentos\\Vendas',
  policy: policy(),
  model: 'm',
  provider: 'p',
  skills: [],
  memory: [],
  isGitRepo: false
}

describe('Cowork surface prompt', () => {
  const cowork = buildSystemPrompt({ ...base, surface: 'cowork' })

  it('keeps the user folder for the deliverables only', () => {
    expect(cowork).toContain('A pasta do usuário é para as entregas')
    expect(cowork).toContain('%TEMP%')
  })

  it('checks its own work without photographing the whole screen', () => {
    expect(cowork).toContain('Não capture a tela inteira do usuário')
    expect(cowork).toContain('LibreOffice')
  })

  it('asks before installing software on the user machine', () => {
    expect(cowork).toContain('Instalar pacotes ou programas no computador do usuário')
    expect(cowork).toContain('peça aprovação antes')
  })

  it('sends Office files to the docx/xlsx/pptx skills and the embedded Python, never to pip', () => {
    expect(cowork).toContain('carregue a skill `docx`, `xlsx` ou `pptx` com use_skill')
    expect(cowork).toContain('`openclod-python script.py`')
    expect(cowork).toContain('openclod-office inspect arquivo')
    expect(cowork).toContain('não rode pip')
  })

  it('keeps the plan current as steps finish', () => {
    expect(cowork).toContain('atualize-o com update_plan ao concluir cada passo')
  })

  it('is specific to Cowork: Chat and Code do not get these rules', () => {
    for (const surface of ['chat', 'code'] as const) {
      const other = buildSystemPrompt({ ...base, surface })
      expect(other).not.toContain('A pasta do usuário é para as entregas')
      expect(other).not.toContain('Não capture a tela inteira do usuário')
      expect(other).not.toContain('openclod-python')
    }
  })
})
