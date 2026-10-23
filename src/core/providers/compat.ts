import type { ModelCompat, ProviderConfig } from '../../shared/types.js'

export type ResolvedCompat = Required<ModelCompat>

function bareModel(model: string): string {
  // OpenRouter-style ids carry the vendor prefix ("openai/o4-mini").
  return model.toLowerCase().split('/').pop() ?? model.toLowerCase()
}

/** OpenAI reasoning families reject `temperature` and `max_tokens`. */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(o\d+|gpt-5)/.test(bareModel(model))
}

/** Thinking models that expect their reasoning echoed back inside a tool loop. */
export function needsReasoningEcho(model: string): boolean {
  const id = bareModel(model)
  return /kimi.*(thinking|k2\.5|k3)|deepseek-reasoner|deepseek-r\d|deepseek-v3\.[2-9]|qwq|glm-4\.[5-9]|glm-5/.test(id)
}

/**
 * Explicit `config.compat` values win; anything unset is inferred from the
 * model id and endpoint.
 */
export function resolveCompat(config: Pick<ProviderConfig, 'model' | 'baseUrl' | 'compat'>): ResolvedCompat {
  const reasoning = isOpenAIReasoningModel(config.model)
  const openaiHost = /api\.openai\.com/i.test(config.baseUrl)
  return {
    omitTemperature: config.compat?.omitTemperature ?? reasoning,
    maxTokensField: config.compat?.maxTokensField ?? (openaiHost || reasoning ? 'max_completion_tokens' : 'max_tokens'),
    echoReasoning: config.compat?.echoReasoning ?? needsReasoningEcho(config.model),
    promptCaching: config.compat?.promptCaching ?? true,
    reasoningEffort: config.compat?.reasoningEffort ?? reasoning
  }
}
