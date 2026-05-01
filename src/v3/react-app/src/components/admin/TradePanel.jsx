import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import PipelineStatusHUD from './PipelineStatusHUD'
import { useTradingFloor } from '../../context/TradingFloorContext'
import {
  RUNNER_PROVIDER_OPTIONS,
  RUNNER_PROVIDER_DEFAULTS,
  startClientRunner,
  stopClientRunner,
} from '../../services/runnerClient'
import {
  clearRunnerKeyForProvider,
  getRunnerKeyForProvider,
  getRunnerKeyMetaForProvider,
  purgeExpiredRunnerKeys,
  setRunnerKeyForProvider,
} from '../../utils/runnerKeyStore'
import './TradePanel.css'

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
  if (parts.length > 0) {
    return [...new Set(parts.filter(Boolean))].join(' ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

const TA_PHASE_LABELS = {
  1: 'ANALYSTS',
  2: 'RESEARCH',
  3: 'TRADER',
  4: 'RISK',
}

const TA_DEFAULT_PROVIDER = 'nvidia'
const TA_DEFAULT_QUICK_MODEL = 'stockmark/stockmark-2-100b-instruct'
const TA_DEFAULT_DEEP_MODEL = 'qwen/qwen3-next-80b-a3b-instruct'
const TA_DEFAULT_DRAMA_LEVEL = 'medium'
const TA_DEFAULT_OUTPUT_LANGUAGE = 'English'

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

const normalizeTaOutputLanguage = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  const matched = TA_OUTPUT_LANGUAGE_OPTIONS.find((option) => option.id.toLowerCase() === raw)
  return matched?.id || TA_DEFAULT_OUTPUT_LANGUAGE
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
    setTaRunStats,
    setLiveTaReports,
    setAgentStates,
  } = useTradingFloor()

  const { taRunStats } = state

  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [cycleCount, setCycleCount] = useState(0)
  const [decisionError, setDecisionError] = useState(null)

  const [taTicker, setTaTicker] = useState('NVDA')
  const [taDate, setTaDate] = useState(() => new Date().toISOString().split('T')[0])
  const [taDepth, setTaDepth] = useState('quick')
  const [taProvider, setTaProvider] = useState(TA_DEFAULT_PROVIDER)
  const [taDeepModel, setTaDeepModel] = useState(TA_DEFAULT_DEEP_MODEL)
  const [taQuickModel, setTaQuickModel] = useState(TA_DEFAULT_QUICK_MODEL)
  const [taDramaLevel, setTaDramaLevel] = useState(TA_DEFAULT_DRAMA_LEVEL)
  const [taOutputLanguage, setTaOutputLanguage] = useState(TA_DEFAULT_OUTPUT_LANGUAGE)
  const [taApiKey, setTaApiKey] = useState('')
  const [taApiKeyMeta, setTaApiKeyMeta] = useState(null)
  const [isTaRunning, setIsTaRunning] = useState(false)
  const [taPhase, setTaPhase] = useState('IDLE')
  const [taTickerStatus, setTaTickerStatus] = useState('')
  const [, setTaStatusMessage] = useState('READY')
  const [taPhaseNum, setTaPhaseNum] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(true)

  const syncProviderDefaults = useCallback((provider) => {
    const defaults = RUNNER_PROVIDER_DEFAULTS[provider] || {
      quickModel: TA_DEFAULT_QUICK_MODEL,
      deepModel: TA_DEFAULT_DEEP_MODEL,
    }
    setTaQuickModel(String(defaults.quickModel || ''))
    setTaDeepModel(String(defaults.deepModel || defaults.quickModel || ''))
  }, [])

  const loadProviderKey = useCallback((provider) => {
    purgeExpiredRunnerKeys()
    const next = getRunnerKeyForProvider(provider)
    setTaApiKey(next)
    setTaApiKeyMeta(getRunnerKeyMetaForProvider(provider))
  }, [])

  useEffect(() => {
    loadProviderKey(taProvider)
  }, [taProvider, loadProviderKey])

  useEffect(() => {
    if (decisionError) {
      const timer = setTimeout(() => setDecisionError(null), 8000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [decisionError])

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
      return
    }
    if (isTaRunning) {
      setIsTaRunning(false)
      setIsAnalyzing(false)
    }
  }, [taRunStats?.running, isTaRunning])

  const resetAgentStatusesForRun = useCallback(() => {
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
  }, [setAgentStates, setLiveTaReports])

  const applyRunnerProgress = useCallback((event, params) => {
    const { ticker, date, depth, provider, quickModel, deepModel } = params
    const now = event?.timestamp || new Date().toISOString()

    if (event?.type === 'start') {
      resetTaRunStats({
        runId: event.runId || null,
        running: true,
        startTime: now,
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
        status: 'running',
      })

      setPipelineState((prev) => ({
        ...prev,
        pipeline_mode: 'tradingagents',
        phase: 'INIT',
        phase_num: 1,
        current_phase: 1,
        ticker,
        current_ticker: ticker,
        trade_date: date,
        llm_provider: provider,
        quick_model: quickModel,
        deep_model: deepModel,
        output_language: taOutputLanguage,
        drama_level: taDramaLevel,
        scene_dialogue_preset: TA_DRAMA_TO_SCENE_PRESET[taDramaLevel] || TA_DRAMA_TO_SCENE_PRESET[TA_DEFAULT_DRAMA_LEVEL],
        research_depth: depth,
        active_run_id: event.runId || prev?.active_run_id || null,
        current_step: 'market_analyst',
        agent_display_name: 'Market Analyst',
        action: `Starting ${depth.toUpperCase()} TradingAgents analysis for ${ticker}...`,
        status: 'STARTING',
        timestamp: now,
      }))
      return
    }

    if (event?.type === 'phase') {
      setTaPhase(event.phase || 'RUNNING')
      setTaPhaseNum(Number(event.phaseNum || 0))
      setPipelineState((prev) => ({
        ...prev,
        pipeline_mode: 'tradingagents',
        phase: event.phase || prev.phase,
        phase_num: Number(event.phaseNum || prev.phase_num || 0),
        current_phase: Number(event.phaseNum || prev.current_phase || 0),
        current_step: event.currentStep || prev.current_step,
        agent_display_name: event.agentDisplayName || prev.agent_display_name,
        action: `${event.agentDisplayName || 'Agent'} working on ${ticker}`,
        status: 'RUNNING',
        cycle: Number(event.phaseNum || 1),
        timestamp: now,
      }))
      return
    }

    if (event?.type === 'completed') {
      const pkg = event.package || {}
      const action = String(pkg?.model_action || pkg?.recommended_action || 'HOLD').toUpperCase()
      setTaRunStats((prev) => ({
        ...prev,
        runId: event.runId || prev.runId || null,
        running: false,
        completed: true,
        status: 'completed',
        endTime: now,
        decision: action,
      }))
      setPipelineState((prev) => ({
        ...prev,
        pipeline_mode: 'tradingagents',
        phase: 'COMPLETE',
        phase_num: 5,
        current_phase: 5,
        current_step: 'risk_judge',
        agent_display_name: 'Risk Judge',
        action: `Completed with ${action}`,
        status: 'COMPLETED',
        timestamp: now,
      }))
      setIsTaRunning(false)
      setIsAnalyzing(false)
      return
    }

    if (event?.type === 'failed' || event?.type === 'aborted') {
      setTaRunStats((prev) => ({
        ...prev,
        running: false,
        completed: false,
        status: event.type === 'aborted' ? 'aborted' : 'failed',
        endTime: now,
      }))
      setPipelineState((prev) => ({
        ...prev,
        phase: 'IDLE',
        phase_num: 0,
        current_phase: 0,
        status: event.type === 'aborted' ? 'ABORTED' : 'FAILED',
        action: event.type === 'aborted' ? 'Run aborted by user.' : (event.error || 'Run failed.'),
        timestamp: now,
      }))
      setIsTaRunning(false)
      setIsAnalyzing(false)
    }
  }, [resetTaRunStats, setPipelineState, setTaRunStats, taDramaLevel, taOutputLanguage])

  const handleRunTa = async () => {
    const depth = taDepth || 'standard'
    if (!taTicker || isTaRunning) return
    if (taProvider !== 'ollama' && !String(taApiKey || '').trim()) {
      setDecisionError('API key is required for this provider.')
      return
    }

    setDecisionError(null)
    setIsTaRunning(true)
    setIsAnalyzing(true)
    setTaTickerStatus(taTicker)
    setTaPhase('INIT')
    setTaPhaseNum(1)
    setTaStatusMessage(`Starting ${depth.toUpperCase()} TradingAgents analysis for ${taTicker}...`)

    const ticker = String(taTicker || '').trim().toUpperCase()
    const runParams = {
      ticker,
      date: taDate,
      provider: taProvider,
      quickModel: taQuickModel,
      deepModel: taDeepModel,
      outputLanguage: taOutputLanguage,
      depth,
      dramaLevel: taDramaLevel,
      apiKey: taApiKey,
    }

    resetAgentStatusesForRun()

    try {
      await startClientRunner(runParams, {
        onProgress: (event) => applyRunnerProgress(event, runParams),
        onError: (error) => setDecisionError(String(error?.message || error || 'Run failed.')),
      })
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setDecisionError(String(error?.message || error || 'Run failed.'))
      }
      setIsTaRunning(false)
      setIsAnalyzing(false)
      setTaPhase('IDLE')
      setTaPhaseNum(0)
      setTaStatusMessage('READY')
    }
  }

  const handleStopTa = async () => {
    try {
      stopClientRunner()
      setIsTaRunning(false)
      setIsAnalyzing(false)
      setTaPhase('IDLE')
      setTaPhaseNum(0)
      setTaStatusMessage('READY')
      setPipelineState((prev) => ({
        ...prev,
        phase: 'IDLE',
        phase_num: 0,
        status: 'ABORTED',
        action: 'Run aborted by user.',
        timestamp: new Date().toISOString(),
      }))
    } catch (error) {
      setDecisionError(String(error?.message || error || 'Stop failed.'))
    }
  }

  const primaryControls = (
    <div className="space-y-2 trade-primary-controls">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Symbol</label>
          <input
            type="text"
            value={taTicker}
            onChange={(e) => setTaTicker(e.target.value.toUpperCase())}
            className="w-full bg-black/40 border border-white/10 p-1 text-[10px] data-mono outline-none focus:border-accent/50 transition-colors trade-input"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Date</label>
          <input
            type="date"
            value={taDate}
            onChange={(e) => setTaDate(e.target.value)}
            className="w-full bg-black/40 border border-white/10 p-1 text-[10px] data-mono outline-none focus:border-accent/50 transition-colors trade-input"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Provider</label>
        <TradeDropdown
          value={taProvider}
          onChange={(nextProvider) => {
            setTaProvider(nextProvider)
            syncProviderDefaults(nextProvider)
            loadProviderKey(nextProvider)
          }}
          options={RUNNER_PROVIDER_OPTIONS.map((provider) => ({ value: provider.id, label: provider.label }))}
          className="uppercase"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">API Key</label>
        <input
          type="password"
          value={taApiKey}
          onChange={(e) => setTaApiKey(e.target.value)}
          placeholder={taProvider === 'azure' ? 'For Azure use: https://endpoint|api-key' : 'Enter provider API key'}
          className="w-full bg-black/40 border border-white/10 p-1 text-[10px] data-mono outline-none focus:border-accent/50 transition-colors trade-input"
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="tactical-trigger w-full text-[9px] py-1"
            onClick={() => {
              setRunnerKeyForProvider(taProvider, taApiKey)
              setTaApiKeyMeta(getRunnerKeyMetaForProvider(taProvider))
            }}
          >
            SAVE KEY (24H)
          </button>
          <button
            type="button"
            className="tactical-trigger tactical-trigger--red w-full text-[9px] py-1"
            onClick={() => {
              clearRunnerKeyForProvider(taProvider)
              setTaApiKey('')
              setTaApiKeyMeta(getRunnerKeyMetaForProvider(taProvider))
            }}
          >
            CLEAR KEY
          </button>
        </div>
        <div className="text-[8px] text-muted data-mono">
          {taApiKeyMeta?.expiresAt
            ? `Stored until ${new Date(taApiKeyMeta.expiresAt).toLocaleString()}`
            : 'No stored key for this provider'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Quick Model</label>
          <input
            type="text"
            value={taQuickModel}
            onChange={(e) => setTaQuickModel(e.target.value)}
            className="w-full bg-black/40 border border-white/10 p-1 text-[10px] data-mono outline-none focus:border-accent/50 transition-colors trade-input"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Deep Model</label>
          <input
            type="text"
            value={taDeepModel}
            onChange={(e) => setTaDeepModel(e.target.value)}
            className="w-full bg-black/40 border border-white/10 p-1 text-[10px] data-mono outline-none focus:border-accent/50 transition-colors trade-input"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <button
          disabled={isTaRunning}
          onClick={() => setTaDepth('quick')}
          data-active={taDepth === 'quick'}
          data-tone="accent"
          className="tactical-trigger tactical-trigger--depth text-[9px] py-1 border-white/10 text-muted"
        >
          QUICK
        </button>
        <button
          disabled={isTaRunning}
          onClick={() => setTaDepth('standard')}
          data-active={taDepth === 'standard'}
          data-tone="highlight"
          className="tactical-trigger tactical-trigger--depth text-[9px] py-1 border-white/10 text-muted"
        >
          STANDARD
        </button>
        <button
          disabled={isTaRunning}
          onClick={() => setTaDepth('deep')}
          data-active={taDepth === 'deep'}
          data-tone="deep"
          className="tactical-trigger tactical-trigger--depth text-[9px] py-1 border-white/10 text-muted"
        >
          DEEP
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          disabled={isTaRunning || !taTicker}
          onClick={handleRunTa}
          className="tactical-trigger tactical-trigger--highlight w-full text-[10px] py-1"
        >
          {isTaRunning ? 'RUNNING PIPELINE...' : `START ${taDepth.toUpperCase()} PIPELINE`}
        </button>
        <button
          disabled={!isTaRunning}
          onClick={handleStopTa}
          className="tactical-trigger tactical-trigger--red w-full text-[10px] py-1"
        >
          STOP
        </button>
      </div>

      <section className="trade-inline-config" aria-label="Trade config controls">
        <header className="reports-command-section-title reports-command-section-title--reader">
          <span>CONFIG</span>
          <span>{showAdvanced ? 'ADVANCED OPEN' : 'PRIMARY + ADVANCED'}</span>
        </header>
        <div className="trade-inline-config-body">{renderAdvancedControls()}</div>
      </section>
    </div>
  )

  function renderAdvancedControls() {
    return (
      <div className="space-y-2 trade-advanced-controls">
      <button
        type="button"
        onClick={() => setShowAdvanced((prev) => !prev)}
        className="tactical-trigger w-full text-[10px] border-accent/40 text-accent hover:bg-accent/10"
      >
        {showAdvanced ? 'HIDE ADVANCED' : 'SHOW ADVANCED'}
      </button>

      {showAdvanced && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Drama Level</label>
            <TradeDropdown
              value={taDramaLevel}
              onChange={(nextDrama) => setTaDramaLevel(nextDrama)}
              options={TA_DRAMA_LEVEL_OPTIONS.map((drama) => ({
                value: drama.id,
                label: drama.label,
              }))}
              className="uppercase"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[8px] font-bold text-muted uppercase tracking-tighter block">Report Language</label>
            <TradeDropdown
              value={taOutputLanguage}
              onChange={(nextLanguageRaw) => setTaOutputLanguage(normalizeTaOutputLanguage(nextLanguageRaw))}
              options={TA_OUTPUT_LANGUAGE_OPTIONS.map((language) => ({
                value: language.id,
                label: language.label,
              }))}
            />
          </div>
        </div>
      )}

      <p className="text-[8px] text-muted text-center mt-1 tracking-widest uppercase">
        Browser-direct BYOK mode
      </p>
      </div>
    )
  }

  return (
    <div className="tab-content final-reports-panel trade-tab-content h-full flex flex-col overflow-hidden">
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
      </AnimatePresence>

      <div className="flex-1 min-h-0">
        <div className={`reports-command-deck reports-command-deck--history trade-command-deck ${isTaRunning ? 'animate-pulse border-highlight/50 shadow-highlight/20' : ''}`.trim()}>
          <div className="reports-command-body">
            <aside className="reports-command-timeline" aria-label="Trade runner controls">
              <header className="reports-command-section-title">
                <span>RUNNER</span>
                <span>{isTaRunning ? 'LIVE' : 'IDLE'}</span>
              </header>
              <div className="trade-panel-scroll">{primaryControls}</div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
