import { TRADE_DECISION_EVENT } from '../utils/tradingAgentRuns'

export const RUNNER_PROVIDER_OPTIONS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'nvidia', label: 'NVIDIA' },
  { id: 'google', label: 'Google' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'glm', label: 'GLM' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'ollama', label: 'Ollama' },
]

export const RUNNER_PROVIDER_DEFAULTS = {
  nvidia: { quickModel: 'stockmark/stockmark-2-100b-instruct', deepModel: 'qwen/qwen3-next-80b-a3b-instruct' },
  openai: { quickModel: 'gpt-5.4-mini', deepModel: 'gpt-5.4' },
  anthropic: { quickModel: 'claude-sonnet-4-6', deepModel: 'claude-opus-4-6' },
  google: { quickModel: 'gemini-3-flash-preview', deepModel: 'gemini-3.1-pro-preview' },
  xai: { quickModel: 'grok-4-1-fast-non-reasoning', deepModel: 'grok-4-0709' },
  deepseek: { quickModel: 'deepseek-chat', deepModel: 'deepseek-reasoner' },
  qwen: { quickModel: 'qwen3.5-flash', deepModel: 'qwen3.6-plus' },
  glm: { quickModel: 'glm-4.7', deepModel: 'glm-5.1' },
  openrouter: { quickModel: '', deepModel: '' },
  azure: { quickModel: 'gpt-5.4-mini', deepModel: 'gpt-5.4' },
  ollama: { quickModel: 'qwen3:latest', deepModel: 'glm-4.7-flash:latest' },
}

const RUNNER_PHASES = [
  { key: 'ANALYSTS', phaseNum: 1, currentStep: 'market_analyst', agentDisplayName: 'Market Analyst' },
  { key: 'RESEARCH', phaseNum: 2, currentStep: 'research_manager', agentDisplayName: 'Research Manager' },
  { key: 'TRADER', phaseNum: 3, currentStep: 'trader', agentDisplayName: 'Trader' },
  { key: 'RISK', phaseNum: 4, currentStep: 'risk_judge', agentDisplayName: 'Risk Judge' },
]

const DEPTH_TO_ROUNDS = { quick: 1, standard: 3, deep: 5 }
const DEPTH_TO_INTERVAL_MS = { quick: 900, standard: 1500, deep: 2200 }

const normalizeProvider = (provider) => String(provider || 'nvidia').trim().toLowerCase()
const normalizeDepth = (depth) => {
  const normalized = String(depth || 'quick').trim().toLowerCase()
  return normalized === 'deep' || normalized === 'standard' ? normalized : 'quick'
}

const runIdNow = (ticker) => `client-${String(ticker || 'TICK').toUpperCase()}-${Date.now()}`

const parseAction = (text = '') => {
  const upper = String(text || '').toUpperCase()
  if (/\b(LIQUIDATE|SELL|REDUCE|TRIM|EXIT)\b/.test(upper)) return 'SELL'
  if (/\b(BUY|ADD|LONG|ACCUMULATE|INCREASE)\b/.test(upper)) return 'BUY'
  if (/\bHOLD\b/.test(upper)) return 'HOLD'
  return 'HOLD'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ensureNotAborted = (signal) => {
  if (signal?.aborted) {
    throw new DOMException('Runner aborted', 'AbortError')
  }
}

const responseTextFromOpenAIResponses = (json) => {
  if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim()
  const output = Array.isArray(json?.output) ? json.output : []
  const chunks = []
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : []
    content.forEach((part) => {
      if (part?.type === 'output_text' && typeof part?.text === 'string') {
        chunks.push(part.text)
      }
    })
  })
  return chunks.join('\n').trim()
}

const responseTextFromChatCompletions = (json) => {
  const choices = Array.isArray(json?.choices) ? json.choices : []
  const first = choices[0] || {}
  const message = first?.message || {}
  if (typeof message?.content === 'string') return message.content.trim()
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim()
  }
  if (typeof first?.text === 'string') return first.text.trim()
  return ''
}

const buildSystemPrompt = ({ outputLanguage }) => (
  `You are a trading decision analyst. Reply in ${String(outputLanguage || 'English')}.\n` +
  'Give a concise recommendation with one action keyword BUY, SELL, or HOLD and short reasoning.'
)

const buildUserPrompt = ({ ticker, date, depth, quickModel, deepModel, dramaLevel, outputLanguage, provider }) => (
  `Ticker: ${ticker}\n` +
  `Date: ${date}\n` +
  `Depth: ${depth}\n` +
  `Provider: ${provider}\n` +
  `Quick model: ${quickModel}\n` +
  `Deep model: ${deepModel}\n` +
  `Drama level: ${dramaLevel}\n` +
  `Output language: ${outputLanguage}\n\n` +
  'Return a short analysis and end with exactly one action line in the form: ACTION: BUY|SELL|HOLD.'
)

const fetchJson = async (url, init) => {
  const response = await fetch(url, init)
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) {
    const msg = json?.error?.message || json?.message || text || `HTTP ${response.status}`
    throw new Error(msg)
  }
  return json || {}
}

const chatCompletionPayload = (ctx) => ({
  model: ctx.deepModel || ctx.quickModel,
  temperature: 0.2,
  messages: [
    { role: 'system', content: buildSystemPrompt(ctx) },
    { role: 'user', content: buildUserPrompt(ctx) },
  ],
})

const runProviderRequest = async (ctx, signal) => {
  ensureNotAborted(signal)
  const provider = normalizeProvider(ctx.provider)
  const model = ctx.deepModel || ctx.quickModel
  const headers = { 'Content-Type': 'application/json' }
  if (provider !== 'ollama' && provider !== 'azure') {
    if (!ctx.apiKey) throw new Error(`Missing API key for ${provider}`)
    headers.Authorization = `Bearer ${ctx.apiKey}`
  }

  if (provider === 'openai') {
    const json = await fetchJson('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: buildSystemPrompt(ctx) }] },
          { role: 'user', content: [{ type: 'input_text', text: buildUserPrompt(ctx) }] },
        ],
      }),
      signal,
    })
    return responseTextFromOpenAIResponses(json)
  }

  if (provider === 'azure') {
    const [endpointPart, apiKeyPart] = String(ctx.apiKey || '').split('|')
    const endpoint = String(endpointPart || '').trim().replace(/\/+$/, '')
    const key = String(apiKeyPart || '').trim()
    if (!endpoint || !key) {
      throw new Error('Azure key format must be "<endpoint>|<api-key>"')
    }
    const json = await fetchJson(`${endpoint}/openai/responses?api-version=2025-03-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': key,
      },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: buildSystemPrompt(ctx) }] },
          { role: 'user', content: [{ type: 'input_text', text: buildUserPrompt(ctx) }] },
        ],
      }),
      signal,
    })
    return responseTextFromOpenAIResponses(json)
  }

  if (provider === 'anthropic') {
    const json = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system: buildSystemPrompt(ctx),
        messages: [{ role: 'user', content: buildUserPrompt(ctx) }],
      }),
      signal,
    })
    const parts = Array.isArray(json?.content) ? json.content : []
    return parts.map((part) => part?.text || '').join('\n').trim()
  }

  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`
    const json = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: `${buildSystemPrompt(ctx)}\n\n${buildUserPrompt(ctx)}` }],
        }],
      }),
      signal,
    })
    return (json?.candidates || [])
      .flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => part?.text || '')
      .join('\n')
      .trim()
  }

  if (provider === 'ollama') {
    const json = await fetchJson('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: buildSystemPrompt(ctx) },
          { role: 'user', content: buildUserPrompt(ctx) },
        ],
      }),
      signal,
    })
    return String(json?.message?.content || '').trim()
  }

  const chatEndpoints = {
    nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
    xai: 'https://api.x.ai/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  }

  const endpoint = chatEndpoints[provider]
  if (!endpoint) {
    throw new Error(`Unsupported provider: ${provider}`)
  }
  const providerHeaders = {
    ...headers,
  }
  if (provider === 'openrouter') {
    providerHeaders['HTTP-Referer'] = window.location.origin
    providerHeaders['X-Title'] = 'TradingAgents Runner'
  }
  const json = await fetchJson(endpoint, {
    method: 'POST',
    headers: providerHeaders,
    body: JSON.stringify(chatCompletionPayload(ctx)),
    signal,
  })
  return responseTextFromChatCompletions(json)
}

const buildDecisionPackage = ({
  runId,
  config,
  outputText,
  startedAt,
}) => {
  const action = parseAction(outputText)
  return {
    run_id: runId,
    ticker: config.ticker,
    trade_date: config.date,
    run_status: 'COMPLETED',
    status: 'completed',
    llm_provider: config.provider,
    quick_model: config.quickModel,
    deep_model: config.deepModel,
    output_language: config.outputLanguage,
    drama_level: config.dramaLevel,
    research_depth: config.depth,
    model_action: action,
    recommended_action: action,
    reasoning: outputText,
    prediction: outputText,
    report_excerpt: outputText.slice(0, 600),
    raw_state: {
      final_trade_decision: outputText,
      llm_provider: config.provider,
      quick_model: config.quickModel,
      deep_model: config.deepModel,
      output_language: config.outputLanguage,
      drama_level: config.dramaLevel,
      research_depth: config.depth,
      run_id: runId,
    },
    created_at: startedAt,
    completed_at: new Date().toISOString(),
  }
}

let activeRunner = null

export const getActiveRunner = () => activeRunner

export const stopClientRunner = () => {
  if (!activeRunner) return false
  activeRunner.controller.abort()
  activeRunner = null
  return true
}

export const startClientRunner = async (inputConfig, callbacks = {}) => {
  if (activeRunner) {
    throw new Error('A client runner execution is already active.')
  }

  const normalizedConfig = {
    ticker: String(inputConfig?.ticker || '').trim().toUpperCase(),
    date: String(inputConfig?.date || new Date().toISOString().slice(0, 10)).trim(),
    provider: normalizeProvider(inputConfig?.provider),
    quickModel: String(inputConfig?.quickModel || '').trim(),
    deepModel: String(inputConfig?.deepModel || inputConfig?.quickModel || '').trim(),
    depth: normalizeDepth(inputConfig?.depth),
    dramaLevel: String(inputConfig?.dramaLevel || 'medium').trim().toLowerCase(),
    outputLanguage: String(inputConfig?.outputLanguage || 'English').trim() || 'English',
    apiKey: String(inputConfig?.apiKey || '').trim(),
  }

  if (!normalizedConfig.ticker) {
    throw new Error('Ticker is required.')
  }
  if (!normalizedConfig.quickModel || !normalizedConfig.deepModel) {
    throw new Error('Quick and deep model are required.')
  }

  const runId = runIdNow(normalizedConfig.ticker)
  const startedAt = new Date().toISOString()
  const controller = new AbortController()
  const onProgress = typeof callbacks.onProgress === 'function' ? callbacks.onProgress : () => {}
  const onComplete = typeof callbacks.onComplete === 'function' ? callbacks.onComplete : () => {}
  const onError = typeof callbacks.onError === 'function' ? callbacks.onError : () => {}

  activeRunner = { runId, controller, config: normalizedConfig, startedAt }

  let interval = null
  const rounds = DEPTH_TO_ROUNDS[normalizedConfig.depth] || DEPTH_TO_ROUNDS.quick
  let phaseIndex = 0
  const emitPhase = () => {
    const phase = RUNNER_PHASES[Math.min(phaseIndex, RUNNER_PHASES.length - 1)]
    onProgress({
      type: 'phase',
      runId,
      phase: phase.key,
      phaseNum: phase.phaseNum,
      currentStep: phase.currentStep,
      agentDisplayName: phase.agentDisplayName,
      rounds,
      timestamp: new Date().toISOString(),
    })
    phaseIndex += 1
  }

  try {
    onProgress({
      type: 'start',
      runId,
      ticker: normalizedConfig.ticker,
      timestamp: startedAt,
      rounds,
    })
    emitPhase()
    interval = window.setInterval(emitPhase, DEPTH_TO_INTERVAL_MS[normalizedConfig.depth] || 1200)

    await sleep(20)
    const outputText = await runProviderRequest(normalizedConfig, controller.signal)
    ensureNotAborted(controller.signal)

    const pkg = buildDecisionPackage({
      runId,
      config: normalizedConfig,
      outputText: outputText || `ACTION: HOLD for ${normalizedConfig.ticker}`,
      startedAt,
    })

    onProgress({
      type: 'completed',
      runId,
      phase: 'COMPLETE',
      phaseNum: 5,
      currentStep: 'risk_judge',
      agentDisplayName: 'Risk Judge',
      timestamp: new Date().toISOString(),
      package: pkg,
    })

    window.dispatchEvent(new CustomEvent(TRADE_DECISION_EVENT, { detail: pkg }))
    onComplete(pkg)
    return pkg
  } catch (error) {
    if (error?.name === 'AbortError') {
      onProgress({
        type: 'aborted',
        runId,
        phase: 'IDLE',
        phaseNum: 0,
        timestamp: new Date().toISOString(),
      })
      onError(new Error('Run aborted by user.'))
      throw error
    }
    onProgress({
      type: 'failed',
      runId,
      phase: 'IDLE',
      phaseNum: 0,
      timestamp: new Date().toISOString(),
      error: String(error?.message || error || 'Unknown runner error'),
    })
    onError(error)
    throw error
  } finally {
    if (interval) {
      window.clearInterval(interval)
    }
    if (activeRunner?.runId === runId) {
      activeRunner = null
    }
  }
}

