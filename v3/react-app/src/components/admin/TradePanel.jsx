import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import PipelineStatusHUD from './PipelineStatusHUD'
import { useTradingFloor } from '../../context/TradingFloorContext'
import './TradePanel.css'

const API_BASE = ''

const readJsonSafely = async (response) => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const formatApiError = (value, fallback = 'Request failed.') => {
  if (!value) return fallback
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message || fallback
  if (typeof value !== 'object') return String(value)

  const parts = []
  const primary = value.message || value.detail || value.error
  if (primary && primary !== value) {
    parts.push(formatApiError(primary, fallback))
  }
  const sidecar = value.sidecar?.detail || value.sidecar?.message || value.sidecar?.error
  if (sidecar) {
    parts.push(formatApiError(sidecar, 'Sidecar error.'))
  }
  if (parts.length > 0) {
    return [...new Set(parts.filter(Boolean))].join(' ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

const responseErrorMessage = (data, fallback) => (
  formatApiError(data?.error || data?.detail || data?.message || data, fallback)
)

const isTransientTransportError = (error) => {
  const message = String(error?.message || error || '')
  return (
    /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|ERR_ABORTED|aborted|fetch/i.test(message) ||
    error?.name === 'AbortError'
  )
}

const TA_PHASE_LABELS = {
  1: 'ANALYSTS',
  2: 'RESEARCH',
  3: 'TRADER',
  4: 'RISK',
}

const TRADINGAGENTS_PROVIDER_OPTIONS = [
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
const TA_DEFAULT_PROVIDER = 'nvidia'
const TA_DEFAULT_QUICK_MODEL = 'stockmark/stockmark-2-100b-instruct'
const TA_DEFAULT_DEEP_MODEL = 'qwen/qwen3-next-80b-a3b-instruct'
const TA_DEFAULT_DRAMA_LEVEL = 'medium'
const TA_DEFAULT_OUTPUT_LANGUAGE = 'English'
const TA_NVIDIA_FALLBACK_MODELS = [
  { id: 'stockmark/stockmark-2-100b-instruct', name: 'Stockmark 2 100B Instruct' },
  { id: 'qwen/qwen3-next-80b-a3b-instruct', name: 'Qwen3 Next 80B A3B Instruct' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'NVIDIA Nemotron 3 Super 120B A12B' },
]

const TA_DRAMA_LEVEL_OPTIONS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

const TA_OUTPUT_LANGUAGE_OPTIONS = [
  { id: 'English', label: 'English' },
  { id: 'Chinese', label: 'Chinese' },
  { id: 'Japanese', label: 'Japanese' },
  { id: 'Korean', label: 'Korean' },
  { id: 'Hindi', label: 'Hindi' },
  { id: 'Spanish', label: 'Spanish' },
  { id: 'Portuguese', label: 'Portuguese' },
  { id: 'French', label: 'French' },
  { id: 'German', label: 'German' },
  { id: 'Arabic', label: 'Arabic' },
  { id: 'Russian', label: 'Russian' },
]

const TA_DRAMA_TO_SCENE_PRESET = {
  low: 'institutional',
  medium: 'buy_side_pod',
  high: 'war_room',
}

const TA_SCENE_PRESET_TO_DRAMA = Object.fromEntries(
  Object.entries(TA_DRAMA_TO_SCENE_PRESET).map(([drama, preset]) => [preset, drama])
)

const normalizeTaOutputLanguage = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  const matched = TA_OUTPUT_LANGUAGE_OPTIONS.find((option) => option.id.toLowerCase() === raw)
  return matched?.id || TA_DEFAULT_OUTPUT_LANGUAGE
}

const TRADINGAGENTS_PROVIDER_DEFAULTS = {
  nvidia: {
    quickModel: TA_DEFAULT_QUICK_MODEL,
    deepModel: TA_DEFAULT_DEEP_MODEL,
  },
  openai: {
    quickModel: 'gpt-5.4-mini',
    deepModel: 'gpt-5.4',
  },
  anthropic: {
    quickModel: 'claude-sonnet-4-6',
    deepModel: 'claude-opus-4-6',
  },
  google: {
    quickModel: 'gemini-3-flash-preview',
    deepModel: 'gemini-3.1-pro-preview',
  },
  xai: {
    quickModel: 'grok-4-1-fast-non-reasoning',
    deepModel: 'grok-4-0709',
  },
  deepseek: {
    quickModel: 'deepseek-chat',
    deepModel: 'deepseek-reasoner',
  },
  qwen: {
    quickModel: 'qwen3.5-flash',
    deepModel: 'qwen3.6-plus',
  },
  glm: {
    quickModel: 'glm-4.7',
    deepModel: 'glm-5.1',
  },
  openrouter: {
    quickModel: '',
    deepModel: '',
  },
  azure: {
    quickModel: 'gpt-5.4-mini',
    deepModel: 'gpt-5.4',
  },
  ollama: {
    quickModel: 'qwen3:latest',
    deepModel: 'glm-4.7-flash:latest',
  },
}

function TradeDropdown({ value, onChange, options, className = '', disabled = false }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onEscape)
    }
  }, [open])

  const normalizedOptions = useMemo(() => (
    (Array.isArray(options) ? options : [])
      .map((option) => {
        if (!option) return null
        if (typeof option === 'string') {
          return { value: option, label: option }
        }
        const resolvedValue = String(option.value ?? option.id ?? '')
        if (!resolvedValue) return null
        return {
          value: resolvedValue,
          label: option.label || option.name || resolvedValue,
        }
      })
      .filter(Boolean)
  ), [options])

  const selectedOption = normalizedOptions.find((option) => option.value === value)
  const selectedLabel = selectedOption?.label || value || '--'

  return (
    <div className={`trade-dropdown ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        className="trade-select trade-select-control"
      >
        <span className="trade-select-control__label">{selectedLabel}</span>
        <span className={`trade-select-caret ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="trade-select-menu" role="listbox">
          {normalizedOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`trade-select-option ${option.value === value ? 'is-selected' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TradePanel() {
  const {
    state,
    setPipelineState,
    resetTaRunStats,
    setLiveTaReports,
    setAgentStates,
  } = useTradingFloor()

  const { taRunStats } = state
  const isBackendConnected = Boolean(state.connected)

  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [cycleCount, setCycleCount] = useState(0)
  const [decisionError, setDecisionError] = useState(null)
  const [decisionNotice, setDecisionNotice] = useState(null)

  const [taTicker, setTaTicker] = useState('NVDA')
  const [taDate, setTaDate] = useState(() => new Date().toISOString().split('T')[0])
  const [taDepth, setTaDepth] = useState('quick')
  const [taProvider, setTaProvider] = useState(TA_DEFAULT_PROVIDER)
  const [taDeepModel, setTaDeepModel] = useState(TA_DEFAULT_DEEP_MODEL)
  const [taQuickModel, setTaQuickModel] = useState(TA_DEFAULT_QUICK_MODEL)
  const [taDramaLevel, setTaDramaLevel] = useState(TA_DEFAULT_DRAMA_LEVEL)
  const [taOutputLanguage, setTaOutputLanguage] = useState(TA_DEFAULT_OUTPUT_LANGUAGE)
  const [isTaRunning, setIsTaRunning] = useState(false)
  const [availableModels, setAvailableModels] = useState([])
  const [sceneModelHealth, setSceneModelHealth] = useState({})
  const [sceneWriterModels, setSceneWriterModels] = useState([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [taPhase, setTaPhase] = useState('IDLE')
  const [taTickerStatus, setTaTickerStatus] = useState('')
  const [, setTaStatusMessage] = useState('READY')
  const [taPhaseNum, setTaPhaseNum] = useState(0)
  const [, setLastRunStartLocal] = useState(0)
  const [activeRunnerStep, setActiveRunnerStep] = useState(3)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [showSceneWriterControls, setShowSceneWriterControls] = useState(false)
  const [taAutoSceneWriterEnabled, setTaAutoSceneWriterEnabled] = useState(false)
  const [taAutoSceneWriterProvider, setTaAutoSceneWriterProvider] = useState('')
  const [taAutoSceneWriterModel, setTaAutoSceneWriterModel] = useState('')
  const [taAutoSceneWriterAvailableModels, setTaAutoSceneWriterAvailableModels] = useState([])
  const [isLoadingAutoSceneWriterModels, setIsLoadingAutoSceneWriterModels] = useState(false)

  const sceneWriterHealthSummary = useMemo(() => {
    const healthRows = Object.values(sceneModelHealth || {})
    const usableRows = healthRows
      .filter((row) => row?.usable_for_scene_writer === true)
      .sort((a, b) => {
        const left = Number.isFinite(Number(a.scene_writer_rank)) ? Number(a.scene_writer_rank) : 999
        const right = Number.isFinite(Number(b.scene_writer_rank)) ? Number(b.scene_writer_rank) : 999
        return left - right
      })
    return {
      testedCount: healthRows.length,
      usableCount: usableRows.length,
      usableNames: usableRows.slice(0, 5).map((row) => row?.name || row?.id).filter(Boolean),
    }
  }, [sceneModelHealth])

  const formatTradingAgentsModelLabel = useCallback((model) => {
    const base = model?.name || model?.id || 'Unknown Model'
    if (taProvider !== 'nvidia') return base
    const health = sceneModelHealth?.[model?.id]
    if (!health) return base
    if (health.usable_for_scene_writer === true) {
      const rank = Number.isFinite(Number(health.scene_writer_rank)) ? ` #${health.scene_writer_rank}` : ''
      return `${base} - Scene JSON OK${rank}`
    }
    if (health.usable_for_scene_writer === false) {
      return `${base} - Not recommended for scene JSON`
    }
    return base
  }, [sceneModelHealth, taProvider])

  const modelOptions = useMemo(() => {
    const optionsById = new Map()
    availableModels.forEach((model) => {
      if (!model?.id) return
      optionsById.set(model.id, model)
    })
    ;[
      TA_DEFAULT_QUICK_MODEL,
      TA_DEFAULT_DEEP_MODEL,
      taQuickModel,
      taDeepModel,
    ]
      .filter(Boolean)
      .forEach((id) => {
        if (!optionsById.has(id)) {
          optionsById.set(id, { id, name: id })
        }
      })
    return Array.from(optionsById.values())
  }, [availableModels, taQuickModel, taDeepModel])

  const autoSceneWriterProviderResolved = useMemo(
    () => (taAutoSceneWriterProvider || taProvider),
    [taAutoSceneWriterProvider, taProvider],
  )

  const autoSceneWriterModelOptions = useMemo(() => {
    const sourceModels = autoSceneWriterProviderResolved === taProvider
      ? availableModels
      : taAutoSceneWriterAvailableModels
    const optionsById = new Map()
    sourceModels.forEach((model) => {
      if (!model?.id) return
      optionsById.set(model.id, model)
    })
    const isOllamaSceneWriter = autoSceneWriterProviderResolved === 'ollama'
    if (!isOllamaSceneWriter) {
      const providerDefaults = TRADINGAGENTS_PROVIDER_DEFAULTS[autoSceneWriterProviderResolved] || { quickModel: '', deepModel: '' }
      ;[
        providerDefaults.quickModel,
        providerDefaults.deepModel,
        taAutoSceneWriterModel,
      ]
        .filter(Boolean)
        .forEach((id) => {
          if (!optionsById.has(id)) {
            optionsById.set(id, { id, name: id })
          }
        })
    }
    return Array.from(optionsById.values())
  }, [
    autoSceneWriterProviderResolved,
    taProvider,
    availableModels,
    taAutoSceneWriterAvailableModels,
    taAutoSceneWriterModel,
  ])

  const isOllamaSceneWriter = autoSceneWriterProviderResolved === 'ollama'
  const autoSceneWriterModelValue = useMemo(() => {
    if (isOllamaSceneWriter) {
      return taAutoSceneWriterModel || autoSceneWriterModelOptions[0]?.id || ''
    }
    return taAutoSceneWriterModel || '__AUTO_DEEP__'
  }, [isOllamaSceneWriter, taAutoSceneWriterModel, autoSceneWriterModelOptions])

  const fetchTradingAgentsConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/admin/tradingagents/config`, { cache: 'no-store' })
      const data = await readJsonSafely(response)
      if (!response.ok || !data) return

      const allowedProviders = new Set(TRADINGAGENTS_PROVIDER_OPTIONS.map((provider) => provider.id))
      const rawProvider = String(data.llm_provider || '').trim().toLowerCase()
      const nextProvider = allowedProviders.has(rawProvider) ? rawProvider : TA_DEFAULT_PROVIDER
      const rawAutoSceneWriterProvider = String(data.auto_scene_writer_provider || '').trim().toLowerCase()
      const nextAutoSceneWriterProvider = allowedProviders.has(rawAutoSceneWriterProvider)
        ? rawAutoSceneWriterProvider
        : ''
      const defaults = TRADINGAGENTS_PROVIDER_DEFAULTS[nextProvider] || {
        quickModel: TA_DEFAULT_QUICK_MODEL,
        deepModel: TA_DEFAULT_DEEP_MODEL,
      }
      const nextQuick = String(data.quick_model || '').trim() || defaults.quickModel
      const nextDeep = String(data.deep_model || '').trim() || defaults.deepModel
      const rawDrama = String(data.drama_level || '').trim().toLowerCase()
      const rawPreset = String(data.scene_dialogue_preset || '').trim().toLowerCase()
      const nextDrama = TA_DRAMA_LEVEL_OPTIONS.some((option) => option.id === rawDrama)
        ? rawDrama
        : (TA_SCENE_PRESET_TO_DRAMA[rawPreset] || TA_DEFAULT_DRAMA_LEVEL)
      const nextOutputLanguage = normalizeTaOutputLanguage(data.output_language)

      setTaProvider(nextProvider)
      setTaQuickModel(nextQuick)
      setTaDeepModel(nextDeep)
      setTaDramaLevel(nextDrama)
      setTaOutputLanguage(nextOutputLanguage)
      setTaAutoSceneWriterEnabled(Boolean(data.auto_scene_writer_enabled ?? false))
      setTaAutoSceneWriterProvider(nextAutoSceneWriterProvider)
      setTaAutoSceneWriterModel(String(data.auto_scene_writer_model || '').trim())
    } catch (error) {
      if (!isTransientTransportError(error)) {
        console.error('Failed to fetch TradingAgents config:', error)
      }
    }
  }, [])

  const persistTradingAgentsConfig = useCallback(async (overrides = {}) => {
    const nextDramaLevel = String(overrides.drama_level ?? taDramaLevel ?? TA_DEFAULT_DRAMA_LEVEL).toLowerCase()
    const normalizedDrama = TA_DRAMA_LEVEL_OPTIONS.some((option) => option.id === nextDramaLevel)
      ? nextDramaLevel
      : TA_DEFAULT_DRAMA_LEVEL
    const mappedPreset = TA_DRAMA_TO_SCENE_PRESET[normalizedDrama] || TA_DRAMA_TO_SCENE_PRESET[TA_DEFAULT_DRAMA_LEVEL]
    const payload = {
      llm_provider: overrides.llm_provider ?? taProvider,
      quick_model: overrides.quick_model ?? taQuickModel,
      deep_model: overrides.deep_model ?? taDeepModel,
      output_language: normalizeTaOutputLanguage(overrides.output_language ?? taOutputLanguage),
      drama_level: normalizedDrama,
      scene_dialogue_preset: mappedPreset,
      auto_scene_writer_enabled: Object.prototype.hasOwnProperty.call(overrides, 'auto_scene_writer_enabled')
        ? Boolean(overrides.auto_scene_writer_enabled)
        : Boolean(taAutoSceneWriterEnabled),
      auto_scene_writer_provider: Object.prototype.hasOwnProperty.call(overrides, 'auto_scene_writer_provider')
        ? String(overrides.auto_scene_writer_provider || '')
        : String(taAutoSceneWriterProvider || ''),
      auto_scene_writer_model: Object.prototype.hasOwnProperty.call(overrides, 'auto_scene_writer_model')
        ? String(overrides.auto_scene_writer_model || '')
        : String(taAutoSceneWriterModel || ''),
    }
    try {
      const response = await fetch(`${API_BASE}/api/admin/tradingagents/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await readJsonSafely(response)
    } catch (error) {
      if (!isTransientTransportError(error)) {
        console.error('Failed to persist TradingAgents config:', error)
      }
    }
  }, [taDeepModel, taOutputLanguage, taProvider, taQuickModel, taDramaLevel, taAutoSceneWriterEnabled, taAutoSceneWriterProvider, taAutoSceneWriterModel])

  const fetchAvailableModels = useCallback(async (provider = taProvider) => {
    setIsLoadingModels(true)
    setAvailableModels([])
    setSceneModelHealth({})
    setSceneWriterModels([])
    try {
      const modelResponse = await fetch(
        `${API_BASE}/api/admin/tradingagents/models?provider=${encodeURIComponent(provider)}`,
        { cache: 'no-store' },
      )
      const data = await readJsonSafely(modelResponse)
      if (!modelResponse.ok || !data) {
        const fallbackModels = provider === 'nvidia' ? TA_NVIDIA_FALLBACK_MODELS : []
        setAvailableModels(fallbackModels)
        return
      }
      if (!data?.success) {
        const fallbackModels = provider === 'nvidia' ? TA_NVIDIA_FALLBACK_MODELS : []
        setAvailableModels(fallbackModels)
        return
      }

      const models = Array.isArray(data.models) ? data.models : []
      const modelIds = new Set(models.map((model) => model.id))
      const fallbackDefaults = TRADINGAGENTS_PROVIDER_DEFAULTS[provider] || { quickModel: '', deepModel: '' }
      const nextQuick = data.default_quick_model || fallbackDefaults.quickModel || models[0]?.id || ''
      const nextDeep = data.default_deep_model || fallbackDefaults.deepModel || models[0]?.id || nextQuick

      setAvailableModels(models)
      setTaQuickModel((prev) => {
        if (prev && (!models.length || modelIds.has(prev))) return prev
        return nextQuick
      })
      setTaDeepModel((prev) => {
        if (prev && (!models.length || modelIds.has(prev))) return prev
        return nextDeep
      })

      if (provider === 'nvidia') {
        const healthResponse = await fetch(
          `${API_BASE}/api/admin/tradingagents/models/health?provider=${encodeURIComponent(provider)}`,
          { cache: 'no-store' },
        )
        const healthData = await readJsonSafely(healthResponse)
        if (healthResponse.ok && healthData) {
          const healthModels = Array.isArray(healthData?.models) ? healthData.models : []
          setSceneModelHealth(Object.fromEntries(healthModels.map((model) => [model.id, model])))
          setSceneWriterModels(Array.isArray(healthData?.scene_writer_models) ? healthData.scene_writer_models : [])
        }
      }
    } catch (error) {
      console.error(`Failed to fetch ${provider} models:`, error)
      setAvailableModels([])
      setSceneModelHealth({})
      setSceneWriterModels([])
    } finally {
      setIsLoadingModels(false)
    }
  }, [taProvider])

  useEffect(() => {
    if (decisionError) {
      const timer = setTimeout(() => setDecisionError(null), 8000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [decisionError])

  useEffect(() => {
    if (decisionNotice) {
      const timer = setTimeout(() => setDecisionNotice(null), 8000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [decisionNotice])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    fetchTradingAgentsConfig()
    return undefined
  }, [fetchTradingAgentsConfig, isBackendConnected])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    fetchAvailableModels(taProvider)
    return undefined
  }, [fetchAvailableModels, isBackendConnected, taProvider])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    if (!taAutoSceneWriterProvider || taAutoSceneWriterProvider === taProvider) {
      setTaAutoSceneWriterAvailableModels([])
      setIsLoadingAutoSceneWriterModels(false)
      return undefined
    }
    let cancelled = false
    const provider = taAutoSceneWriterProvider
    const loadModels = async () => {
      setIsLoadingAutoSceneWriterModels(true)
      try {
        const response = await fetch(
          `${API_BASE}/api/admin/tradingagents/models?provider=${encodeURIComponent(provider)}`,
          { cache: 'no-store' },
        )
        const data = await readJsonSafely(response)
        if (cancelled) return
        if (!response.ok || !data?.success) {
          const fallbackModels = provider === 'nvidia' ? TA_NVIDIA_FALLBACK_MODELS : []
          setTaAutoSceneWriterAvailableModels(fallbackModels)
          return
        }
        const models = Array.isArray(data.models) ? data.models : []
        setTaAutoSceneWriterAvailableModels(models)
      } catch (error) {
        if (!cancelled) {
          const fallbackModels = provider === 'nvidia' ? TA_NVIDIA_FALLBACK_MODELS : []
          setTaAutoSceneWriterAvailableModels(fallbackModels)
          if (!isTransientTransportError(error)) {
            console.error(`Failed to fetch auto scene writer models for ${provider}:`, error)
          }
        }
      } finally {
        if (!cancelled) setIsLoadingAutoSceneWriterModels(false)
      }
    }
    loadModels()
    return () => {
      cancelled = true
    }
  }, [isBackendConnected, taAutoSceneWriterProvider, taProvider])

  useEffect(() => {
    if (!state.pipelineState) return
    const livePhaseNum = Number(state.pipelineState.phase_num ?? state.pipelineState.current_phase ?? 0)
    if (state.pipelineState.phase && state.pipelineState.phase !== 'IDLE') {
      if (livePhaseNum > 0) {
        setTaPhaseNum(livePhaseNum)
        setTaPhase(
          TA_PHASE_LABELS[livePhaseNum] ||
          state.pipelineState.agent_display_name ||
          state.pipelineState.current_step ||
          state.pipelineState.sub_phase ||
          state.pipelineState.phase
        )
      } else {
        setTaPhase(
          state.pipelineState.agent_display_name ||
          state.pipelineState.current_step ||
          state.pipelineState.sub_phase ||
          state.pipelineState.phase
        )
      }
    }

    const liveStatus = state.pipelineState.status || state.pipelineState.action
    if (liveStatus) {
      setTaStatusMessage(String(liveStatus).replace(/_/g, ' ').toUpperCase())
    }
    if (state.pipelineState.ticker) {
      setTaTickerStatus(state.pipelineState.ticker)
    }

    if (state.pipelineState.cycle !== undefined && state.pipelineState.cycle > 0) {
      setCycleCount(state.pipelineState.cycle)
    } else if (isTaRunning) {
      setCycleCount(1)
    } else {
      setCycleCount(0)
    }
  }, [state.pipelineState, isTaRunning])

  useEffect(() => {
    if (taRunStats?.running) {
      setIsTaRunning(true)
      setIsAnalyzing(true)
      setActiveRunnerStep(3)
      return
    }
    if (isTaRunning) {
      setIsTaRunning(false)
      setIsAnalyzing(false)
    }
  }, [taRunStats?.running, isTaRunning])

  const handleRunTa = async () => {
    const depth = taDepth || 'standard'
    if (!taTicker || isTaRunning) return
    setDecisionError(null)
    setDecisionNotice(null)
    setLastRunStartLocal(Date.now())
    setIsTaRunning(true)
    setIsAnalyzing(true)
    setTaTickerStatus(taTicker)
    setTaPhase('INIT')
    setTaPhaseNum(1)
    setTaStatusMessage(`Starting ${depth.toUpperCase()} TradingAgents analysis for ${taTicker}...`)
    try {
      const response = await fetch(`${API_BASE}/api/admin/trading-agents/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: taTicker,
          date: taDate,
          provider: taProvider,
          quickModel: taQuickModel,
          deepModel: taDeepModel,
          outputLanguage: taOutputLanguage,
          depth,
          dramaLevel: taDramaLevel,
          sceneDialoguePreset: TA_DRAMA_TO_SCENE_PRESET[taDramaLevel] || TA_DRAMA_TO_SCENE_PRESET[TA_DEFAULT_DRAMA_LEVEL],
          autoSceneWriterEnabled: taAutoSceneWriterEnabled,
          autoSceneWriterProvider: taAutoSceneWriterProvider || undefined,
          autoSceneWriterModel: taAutoSceneWriterModel || undefined,
        }),
      })
      const data = await readJsonSafely(response)
      if (!response.ok || !data?.success) {
        setDecisionError(responseErrorMessage(data, 'TradingAgents run failed to start.'))
        setIsTaRunning(false)
        setTaPhase('IDLE')
        setTaPhaseNum(0)
        setTaStatusMessage('READY')
        return
      }

      const preemptedRunIds = Array.isArray(data?.preempted_run_ids) ? data.preempted_run_ids : []
      if (preemptedRunIds.length > 0) {
        const oldRunLabel = preemptedRunIds.length === 1
          ? preemptedRunIds[0]
          : `${preemptedRunIds.length} previous runs`
        setDecisionNotice(`Canceled ${oldRunLabel}. Started new run ${data?.run_id || 'now'}.`)
      }

      const startedAt = new Date().toISOString()
      const optimisticTicker = String(taTicker || '').toUpperCase()
      setLiveTaReports({})
      setAgentStates((prev) => Object.fromEntries(
        Object.entries(prev || {}).map(([name, agent]) => [
          name,
          {
            ...agent,
            status: 'idle',
            decision: null,
            reasoning: null,
            report: null,
            last_action: null,
          },
        ])
      ))
      resetTaRunStats({
        runId: data?.run_id || null,
        running: true,
        startTime: startedAt,
        agentsCompleted: 0,
        completedAgents: 0,
        reportsCompleted: 0,
        reportSectionsCompleted: 0,
        reportsTotal: 12,
        reportSectionsTotal: 12,
        agentsTotal: 12,
        tokensUp: 0,
        tokensDown: 0,
        llmCalls: 0,
        toolCalls: 0,
      })
      setPipelineState((prev) => ({
        ...prev,
        pipeline_mode: 'tradingagents',
        phase: 'init',
        phase_num: 1,
        current_phase: 1,
        ticker: optimisticTicker,
        current_ticker: optimisticTicker,
        trade_date: taDate,
        llm_provider: taProvider,
        quick_model: taQuickModel,
        deep_model: taDeepModel,
        research_depth: depth,
        active_run_id: data?.run_id || prev?.active_run_id || null,
        current_step: 'market_analyst',
        agent_display_name: 'Market Analyst',
        action: `Starting ${depth.toUpperCase()} TradingAgents analysis for ${optimisticTicker}...`,
        status: 'STARTING',
        timestamp: startedAt,
      }))
    } catch (error) {
      console.error(error)
      setDecisionError(String(error))
      setIsTaRunning(false)
      setTaPhase('IDLE')
      setTaPhaseNum(0)
      setTaStatusMessage('READY')
    }
  }

  const resetTradeRunnerToIdle = useCallback((notice = 'Pipeline stopped.') => {
    const now = new Date().toISOString()
    setIsTaRunning(false)
    setIsAnalyzing(false)
    setTaPhase('IDLE')
    setTaPhaseNum(0)
    setTaTickerStatus('')
    setTaStatusMessage('READY')
    setDecisionNotice(notice)
    resetTaRunStats({
      runId: null,
      running: false,
      completed: false,
      status: 'idle',
      endTime: now,
    })
    setLiveTaReports({})
    setPipelineState((prev) => ({
      ...prev,
      phase: 'IDLE',
      phase_num: 0,
      current_phase: 0,
      pipeline_mode: null,
      active_run_id: null,
      run_id: null,
      current_step: null,
      agent_display_name: null,
      status: 'WAITING',
      action: 'WAITING',
      timestamp: now,
    }))
  }, [resetTaRunStats, setLiveTaReports, setPipelineState])

  const handleStopTa = async () => {
    setDecisionError(null)
    setDecisionNotice('Stopping pipeline...')
    try {
      const response = await fetch(`${API_BASE}/api/admin/trading-agents/stop?force_reset=true`, { method: 'POST' })
      const data = await readJsonSafely(response)
      if (!response.ok || data?.success === false) {
        throw new Error(responseErrorMessage(data, 'Failed to stop pipeline.'))
      }
      resetTradeRunnerToIdle(String(data?.message || 'Pipeline stopped.'))
    } catch (error) {
      console.error(error)
      setDecisionError(formatApiError(error, 'Failed to stop pipeline.'))
    }
  }

  const primaryControls = (
    <div className="trade-primary-controls">
      <section
        className={`trade-runner-step ${activeRunnerStep === 1 ? 'is-active' : ''}`}
        aria-label="Runner setup step one"
      >
        <header className="trade-runner-step__header">
          <span className="trade-runner-step__title">Step 1 · Setup</span>
          <span className="trade-runner-step__meta">Symbol / Date / Provider</span>
        </header>

        <div className="trade-grid trade-grid--two">
          <div className="trade-field">
            <label className="trade-label">Symbol</label>
            <input
              type="text"
              value={taTicker}
              onChange={(e) => setTaTicker(e.target.value.toUpperCase())}
              className="trade-input trade-input--symbol"
              placeholder="NVDA"
              maxLength={12}
            />
          </div>
          <div className="trade-field">
            <label className="trade-label">Date</label>
            <input
              type="date"
              value={taDate}
              onChange={(e) => setTaDate(e.target.value)}
              className="trade-input trade-input--date"
            />
          </div>
        </div>

        <div className="trade-field">
          <label className="trade-label">Provider</label>
          <TradeDropdown
            value={taProvider}
            onChange={(nextProvider) => {
              const defaults = TRADINGAGENTS_PROVIDER_DEFAULTS[nextProvider] || { quickModel: '', deepModel: '' }
              setTaProvider(nextProvider)
              setAvailableModels([])
              setTaQuickModel(defaults.quickModel)
              setTaDeepModel(defaults.deepModel)
              persistTradingAgentsConfig({
                llm_provider: nextProvider,
                quick_model: defaults.quickModel,
                deep_model: defaults.deepModel,
              })
            }}
            options={TRADINGAGENTS_PROVIDER_OPTIONS.map((provider) => ({ value: provider.id, label: provider.label }))}
            className="uppercase"
          />
        </div>

      </section>

      <section
        className={`trade-runner-step ${activeRunnerStep >= 2 ? 'is-active' : ''}`}
        aria-label="Runner setup step two"
      >
        <header className="trade-runner-step__header">
          <span className="trade-runner-step__title">Step 2 · Models + Depth</span>
          <span className="trade-runner-step__meta">Quick / Deep / Research Depth</span>
        </header>

        <div className="trade-grid trade-grid--two">
          <div className="trade-field">
            <label className="trade-label">Quick Model</label>
            <TradeDropdown
              value={taQuickModel}
              onChange={(nextQuickModel) => {
                setTaQuickModel(nextQuickModel)
                persistTradingAgentsConfig({ quick_model: nextQuickModel })
              }}
              options={modelOptions.map((model) => ({
                value: model.id,
                label: formatTradingAgentsModelLabel(model),
              }))}
            />
          </div>
          <div className="trade-field">
            <label className="trade-label">Deep Model</label>
            <TradeDropdown
              value={taDeepModel}
              onChange={(nextDeepModel) => {
                setTaDeepModel(nextDeepModel)
                persistTradingAgentsConfig({ deep_model: nextDeepModel })
              }}
              options={modelOptions.map((model) => ({
                value: model.id,
                label: formatTradingAgentsModelLabel(model),
              }))}
            />
          </div>
        </div>

        <div className="trade-depth-row">
          <button
            disabled={isTaRunning}
            onClick={() => setTaDepth('quick')}
            data-active={taDepth === 'quick'}
            data-tone="accent"
            className="tactical-trigger tactical-trigger--depth trade-depth-button"
          >
            QUICK
          </button>
          <button
            disabled={isTaRunning}
            onClick={() => setTaDepth('standard')}
            data-active={taDepth === 'standard'}
            data-tone="highlight"
            className="tactical-trigger tactical-trigger--depth trade-depth-button"
          >
            STANDARD
          </button>
          <button
            disabled={isTaRunning}
            onClick={() => setTaDepth('deep')}
            data-active={taDepth === 'deep'}
            data-tone="deep"
            className="tactical-trigger tactical-trigger--depth trade-depth-button"
          >
            DEEP
          </button>
        </div>

      </section>

      <section
        className={`trade-runner-step trade-runner-step--action ${activeRunnerStep >= 3 ? 'is-active' : ''}`}
        aria-label="Runner execute step"
      >
        <header className="trade-runner-step__header">
          <span className="trade-runner-step__title">Step 3 · Execute</span>
          <span className="trade-runner-step__meta">
            {isTaRunning
              ? `LIVE · ${taPhase}`
              : `${(taTickerStatus || taTicker || '----').toUpperCase()} · ${taDepth.toUpperCase()}`}
          </span>
        </header>

        <div className="trade-runner-status">
          <span className="trade-runner-status__pill">{taProvider.toUpperCase()}</span>
          <span className="trade-runner-status__pill">{taDepth.toUpperCase()}</span>
          <span className="trade-runner-status__pill">{isTaRunning ? 'RUNNING' : 'READY'}</span>
        </div>

        <div className="trade-action-row">
          <button
            disabled={isTaRunning || !taTicker || !taQuickModel || !taDeepModel}
            onClick={handleRunTa}
            className="tactical-trigger tactical-trigger--highlight trade-action-button trade-action-button--start"
          >
            {isTaRunning ? 'RUNNING PIPELINE...' : `START ${taDepth.toUpperCase()} PIPELINE`}
          </button>
          <button
            disabled={!isTaRunning}
            onClick={handleStopTa}
            className="tactical-trigger tactical-trigger--red trade-action-button trade-action-button--stop"
          >
            STOP
          </button>
        </div>
      </section>

      <section className="trade-inline-config" aria-label="Trade config controls">
        <header className="reports-command-section-title reports-command-section-title--reader">
          <span>CONFIG</span>
          <button
            type="button"
            onClick={() => setIsAdvancedOpen((prev) => !prev)}
            className="tactical-trigger trade-secondary-action trade-inline-config__toggle"
          >
            {isAdvancedOpen ? 'ADVANCED OPEN' : 'ADVANCED CLOSED'}
          </button>
        </header>
        {isAdvancedOpen && (
          <div className="trade-inline-config-body">{renderAdvancedControls()}</div>
        )}
      </section>
    </div>
  )

  function renderAdvancedControls() {
    return (
      <div className="trade-advanced-controls">
        <div className="trade-advanced-stack">
          <section className="trade-scene-writer-section" aria-label="Scene writer controls">
            <div className="trade-scene-writer-header">
              <span className="trade-label">Scene Writer Controls</span>
              <button
                type="button"
                onClick={() => setShowSceneWriterControls((prev) => !prev)}
                className="tactical-trigger trade-secondary-action trade-scene-writer-toggle border-accent/40 text-accent hover:bg-accent/10"
              >
                {showSceneWriterControls ? 'HIDE' : 'SHOW'}
              </button>
            </div>

            {showSceneWriterControls && (
              <div className="trade-scene-writer-body">
                <div className="trade-scene-writer-grid">
                  <div className="trade-scene-writer-grid__column">
                    <div className="trade-field trade-field--scene-toggle">
                      <div className="flex items-center justify-between gap-2">
                        <label className="trade-label">Auto Scene Writer</label>
                        <button
                          type="button"
                          onClick={() => {
                            const nextEnabled = !taAutoSceneWriterEnabled
                            setTaAutoSceneWriterEnabled(nextEnabled)
                            persistTradingAgentsConfig({ auto_scene_writer_enabled: nextEnabled })
                          }}
                          className="tactical-trigger trade-secondary-action border-accent/40 text-accent hover:bg-accent/10"
                        >
                          {taAutoSceneWriterEnabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      <p className="trade-hint">
                        {taAutoSceneWriterEnabled ? '13 LLM scene calls/run (00-12).' : 'Deterministic preloaded scenes (dialogue/animation/paths).'}
                      </p>
                    </div>

                    <section className="trade-scene-model-stack" aria-label="Scene writer model source">
                      <div className="trade-scene-model-stack__title">Model Source</div>
                      <div className="trade-field trade-field--scene-provider">
                        <label className="trade-label">Auto Scene Writer Provider</label>
                        <TradeDropdown
                          value={taAutoSceneWriterProvider || '__RUN_PROVIDER__'}
                          onChange={(nextProviderRaw) => {
                            const nextProvider = nextProviderRaw === '__RUN_PROVIDER__'
                              ? ''
                              : String(nextProviderRaw || '').trim().toLowerCase()
                            setTaAutoSceneWriterProvider(nextProvider)
                            setTaAutoSceneWriterModel('')
                            persistTradingAgentsConfig({
                              auto_scene_writer_provider: nextProvider,
                              auto_scene_writer_model: '',
                            })
                          }}
                          options={[
                            { value: '__RUN_PROVIDER__', label: 'Use Run Provider (default)' },
                            ...TRADINGAGENTS_PROVIDER_OPTIONS.map((provider) => ({
                              value: provider.id,
                              label: provider.label,
                            })),
                          ]}
                          className="uppercase"
                        />
                      </div>

                      <div className="trade-field trade-field--scene-model">
                        <label className="trade-label">Auto Scene Writer Model</label>
                        <TradeDropdown
                          value={autoSceneWriterModelValue}
                          onChange={(nextModel) => {
                            const modelValue = nextModel === '__AUTO_DEEP__' ? '' : String(nextModel || '')
                            setTaAutoSceneWriterModel(modelValue)
                            persistTradingAgentsConfig({ auto_scene_writer_model: modelValue })
                          }}
                          options={[
                            ...(
                              isOllamaSceneWriter
                                ? []
                                : [{
                                  value: '__AUTO_DEEP__',
                                  label: taAutoSceneWriterProvider
                                    ? 'Use Provider Default Model'
                                    : 'Use Deep Model (default)',
                                }]
                            ),
                            ...autoSceneWriterModelOptions.map((model) => ({
                              value: model.id,
                              label: autoSceneWriterProviderResolved === taProvider
                                ? formatTradingAgentsModelLabel(model)
                                : (model?.name || model?.id),
                            })),
                          ]}
                        />
                        {isOllamaSceneWriter && autoSceneWriterModelOptions.length > 0 && (
                          <p className="trade-hint">Detected {autoSceneWriterModelOptions.length} Ollama models.</p>
                        )}
                        {isLoadingAutoSceneWriterModels && taAutoSceneWriterProvider && taAutoSceneWriterProvider !== taProvider && (
                          <p className="trade-hint">Loading model list for {autoSceneWriterProviderResolved}...</p>
                        )}
                      </div>
                    </section>
                  </div>

                  <div className="trade-scene-writer-grid__column">
                    {autoSceneWriterProviderResolved === 'nvidia' && taProvider === 'nvidia' && sceneWriterHealthSummary.testedCount > 0 && (
                      <div className="trade-scene-health">
                        <div className="trade-scene-health__summary">
                          Scene JSON writer: {sceneWriterHealthSummary.usableCount}/{sceneWriterHealthSummary.testedCount} reliable
                        </div>
                        <div className="trade-scene-health__ladder">
                          Ladder: {(sceneWriterModels.length ? sceneWriterModels : sceneWriterHealthSummary.usableNames).join(' -> ')}
                        </div>
                      </div>
                    )}

                    <div className="trade-field trade-field--scene-drama">
                      <label className="trade-label">Drama Level</label>
                      <TradeDropdown
                        value={taDramaLevel}
                        onChange={(nextDrama) => {
                          setTaDramaLevel(nextDrama)
                          persistTradingAgentsConfig({ drama_level: nextDrama })
                        }}
                        options={TA_DRAMA_LEVEL_OPTIONS.map((drama) => ({
                          value: drama.id,
                          label: drama.label,
                        }))}
                        className="uppercase"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="trade-field">
            <label className="trade-label">Report Language</label>
            <TradeDropdown
              value={taOutputLanguage}
              onChange={(nextLanguageRaw) => {
                const nextLanguage = normalizeTaOutputLanguage(nextLanguageRaw)
                setTaOutputLanguage(nextLanguage)
                persistTradingAgentsConfig({ output_language: nextLanguage })
              }}
              options={TA_OUTPUT_LANGUAGE_OPTIONS.map((language) => ({
                value: language.id,
                label: language.label,
              }))}
            />
          </div>
        </div>

      <p className="trade-footnote">
        {isLoadingModels ? 'Loading model list...' : 'TradingAgents pipeline only'}
      </p>
      </div>
    )
  }

  return (
    <div className="tab-content final-reports-panel trade-tab-content h-full flex flex-col overflow-y-auto overflow-x-hidden">
      <AnimatePresence>
        {isAnalyzing && (
          <PipelineStatusHUD
            currentPhaseNum={taPhaseNum}
            currentPhase={taPhase}
            ticker={taTickerStatus || taTicker}
            cycleCount={cycleCount}
          />
        )}
        {decisionError && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-red-500/20 border-b border-red-500/40 text-red-400 text-[10px] py-0.5 text-center font-medium shrink-0"
          >
            {formatApiError(decisionError, 'Request failed.')}
          </motion.div>
        )}
        {decisionNotice && !decisionError && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-blue-500/20 border-b border-blue-500/40 text-blue-300 text-[10px] py-0.5 text-center font-medium shrink-0"
          >
            {String(decisionNotice)}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-h-0">
        <div className={`reports-command-deck reports-command-deck--history trade-command-deck ${isTaRunning ? 'animate-pulse border-highlight/50 shadow-highlight/20' : ''}`.trim()}>
          <div className="reports-command-body">
            <aside className="reports-command-timeline" aria-label="Trade runner controls">
              <header className="reports-command-section-title">
                <span>RUNNER</span>
                <span>{isTaRunning ? `LIVE · ${taPhase}` : 'IDLE'}</span>
              </header>
              <div className="trade-panel-scroll">{primaryControls}</div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

