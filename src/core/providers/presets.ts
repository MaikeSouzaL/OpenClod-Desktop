import type { ProviderConfig } from '../../shared/types.js'

export interface ProviderPreset {
  kind: ProviderConfig['kind']
  label: string
  baseUrl: string
  model: string
  contextWindow: number
  supportsVision: boolean
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  cachedInputCostPerMTok?: number
  apiKeyEnv?: string
  local?: boolean
  docs?: string
  models?: string[]
  /** Models of `models` that read images, when the provider serves both kinds (see ProviderConfig.visionModels). */
  visionModels?: string[]
  /** Reasoning depth levels the API accepts; omitted = auto-detect. */
  effortLevels?: ProviderConfig['effortLevels']
  /** Default for new sessions; omitted = keep the user's automatic choice. */
  defaultEffort?: ProviderConfig['defaultEffort']
}

/**
 * Model identifiers change frequently; every preset is editable in the UI and
 * the model field is always sent verbatim to the provider.
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    contextWindow: 128_000,
    supportsVision: true,
    models: ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    apiKeyEnv: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/docs/api-reference/chat'
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    contextWindow: 200_000,
    supportsVision: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    docs: 'https://docs.anthropic.com/en/api/messages'
  },
  deepseek: {
    kind: 'openai',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    contextWindow: 1_048_576,
    supportsVision: false,
    // deepseek-flash peak rates (USD / 1M tokens); cache hits are ~50x cheaper.
    inputCostPerMTok: 0.3,
    outputCostPerMTok: 1.2,
    cachedInputCostPerMTok: 0.006,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    // V4.1 Flash / V4 Pro expose three API thinking levels; `max` is the
    // vendor's top tier, not a UI-only alias.
    effortLevels: ['low', 'high', 'max'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    docs: 'https://api-docs.deepseek.com/'
  },
  kimi: {
    kind: 'openai',
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2-0905-preview',
    contextWindow: 256_000,
    supportsVision: false,
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'],
    apiKeyEnv: 'MOONSHOT_API_KEY',
    docs: 'https://platform.moonshot.ai/docs'
  },
  qwen: {
    kind: 'openai',
    label: 'Qwen (DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
    contextWindow: 128_000,
    supportsVision: false,
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'
  },
  openrouter: {
    kind: 'openai',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    contextWindow: 128_000,
    supportsVision: true,
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'google/gemini-2.5-pro'],
    // deepseek/deepseek-chat (the default) reads text only; the other three read images.
    visionModels: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'google/gemini-2.5-pro'],
    apiKeyEnv: 'OPENROUTER_API_KEY',
    docs: 'https://openrouter.ai/docs'
  },
  'opencode-go': {
    kind: 'openai',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'beam-free',
    contextWindow: 128_000,
    supportsVision: true,
    models: [
      'beam-free',
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'qwen3.8-max',
      'glm-5.3',
      'kimi-k3',
      'claude-haiku-5-5',
      'gpt-6-luna',
      'mimo-v2.6-pro',
      'minimax-m3.1-flash-free',
      'longcat-2.5-preview-free'
    ],
    apiKeyEnv: 'OPENCODE_API_KEY',
    docs: 'https://opencode.ai/docs/providers/#opencode-go'
  },
  opencode: {
    kind: 'openai',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    model: 'qwen3-coder',
    contextWindow: 128_000,
    supportsVision: true,
    models: ['qwen3-coder', 'glm-5.3', 'kimi-k3', 'claude-haiku-5-5', 'gpt-6-luna'],
    apiKeyEnv: 'OPENCODE_ZEN_API_KEY',
    docs: 'https://opencode.ai/docs/zen'
  },
  ollama: {
    kind: 'openai',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    contextWindow: 32_000,
    supportsVision: false,
    models: ['qwen3:8b', 'qwen3:14b', 'llama3.2:3b', 'deepseek-r1:8b'],
    local: true,
    docs: 'https://ollama.com/blog/openai-compatibility'
  },
  lmstudio: {
    kind: 'openai',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    contextWindow: 32_000,
    supportsVision: false,
    models: ['local-model'],
    local: true,
    docs: 'https://lmstudio.ai/docs/api/openai-api'
  }
}

export function presetToConfig(key: string): ProviderConfig {
  const preset = PROVIDER_PRESETS[key]
  if (!preset) throw new Error(`preset desconhecido: ${key}`)
  return {
    id: key,
    kind: preset.kind,
    label: preset.label,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKeyRef: preset.apiKeyEnv ? `env:${preset.apiKeyEnv}` : '',
    contextWindow: preset.contextWindow,
    supportsVision: preset.supportsVision,
    supportsTools: true,
    models: preset.models ? [...preset.models] : [preset.model],
    visionModels: preset.visionModels ? [...preset.visionModels] : undefined,
    inputCostPerMTok: preset.inputCostPerMTok,
    outputCostPerMTok: preset.outputCostPerMTok,
    cachedInputCostPerMTok: preset.cachedInputCostPerMTok,
    effortLevels: preset.effortLevels ? [...preset.effortLevels] : undefined,
    defaultEffort: preset.defaultEffort
  }
}
