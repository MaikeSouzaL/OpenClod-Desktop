import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/agent/context'
import { toolsForMode } from '../src/core/security/permissions'
import { AGENT_MODES, defaultAgentMode } from '../src/shared/types'
import { policy } from './helpers'

// The Início (Chat) surface used to open in the read-only "ask" mode and told the model not to change anything: asked to "crie uma
// pasta na minha área de trabalho chamada azul" it used one tool and answered with instructions for the user to follow. Chat now
// opens in Computer Use, which has the files, the terminal and the whole Computer Use set; the permission policy still decides what
// asks for approval.

const base = {
  mode: 'computer' as const,
  cwd: 'C:\\Users\\ana\\Desktop',
  policy: policy(),
  model: 'm',
  provider: 'p',
  skills: [],
  memory: [],
  isGitRepo: false
}

const CHAT_ACTIONS = [
  'run_command',
  'write_file',
  'list_dir',
  'computer_screenshot',
  'computer_snapshot',
  'computer_click',
  'computer_type_text',
  'computer_press_key',
  'computer_launch',
  'computer_open_path',
  'computer_secondary_action'
]

describe('the mode a new session opens in', () => {
  it('opens Chat in Computer Use, and keeps Cowork autonomous and Code in code', () => {
    expect(defaultAgentMode('chat')).toBe('computer')
    expect(defaultAgentMode('cowork')).toBe('autonomous')
    expect(defaultAgentMode('code')).toBe('code')
  })

  it('is always a mode the harness knows', () => {
    for (const surface of ['chat', 'cowork', 'code'] as const) expect(AGENT_MODES).toContain(defaultAgentMode(surface))
  })
})

describe('Chat can use the computer', () => {
  it('its mode has the tools to act: files, terminal and the whole Computer Use set', () => {
    const tools = toolsForMode(defaultAgentMode('chat'))
    for (const name of CHAT_ACTIONS) expect(tools, name).toContain(name)
  })

  it('no longer tells the model to leave files alone and send the user elsewhere', () => {
    const chat = buildSystemPrompt({ ...base, surface: 'chat' })
    expect(chat).not.toContain('não altere arquivos no Chat')
    expect(chat).not.toContain('sugira mudar para Cowork ou Code')
    expect(chat).toContain('Você age no computador do usuário quando ele pede')
    expect(chat).toContain('em vez de só explicar como ele faria')
    expect(chat).toContain('tool_search')
  })

  it('still asks before destroying or overwriting what the user did not mention, and reports what it did', () => {
    const chat = buildSystemPrompt({ ...base, surface: 'chat' })
    expect(chat).toContain('peça aprovação')
    expect(chat).toContain('nunca apague permanentemente sem confirmação explícita')
    expect(chat).toContain('diga o que fez e onde')
  })

  it('is conversational first: tools only when the request needs them', () => {
    expect(buildSystemPrompt({ ...base, surface: 'chat' })).toContain('só use ferramentas quando o pedido exigir')
  })
})

describe('the read-only modes stay read-only', () => {
  it('ask, plan and review cannot click, type, launch or run commands', () => {
    for (const mode of ['ask', 'plan', 'review'] as const) {
      const tools = toolsForMode(mode)
      for (const name of ['run_command', 'write_file', 'computer_click', 'computer_type_text', 'computer_launch', 'computer_open_path']) {
        expect(tools, `${mode} / ${name}`).not.toContain(name)
      }
    }
  })
})
