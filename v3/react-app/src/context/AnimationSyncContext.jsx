// Animation Sync Context - Provides animation state and controls to components
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { UNIFIED_PHASES } from '../components/MetroFlow'
import { getIdleBehaviorEngine } from '../components/trading-floor/canvas/animators/IdleBehaviorEngine'
import { getDataFetchAnimator } from '../components/trading-floor/canvas/animators/DataFetchAnimator'
import { getConsensusScene } from '../components/trading-floor/canvas/animators/ConsensusScene'
import { getOfflineAnimationEngine } from '../components/trading-floor/canvas/animators/OfflineAnimationEngine'
import { useConnectionMonitor } from '../hooks/useConnectionMonitor'
import { MovePriority } from '../components/trading-floor/canvas/MovementManager'

const AnimationSyncContext = createContext(null)

export function AnimationSyncProvider({ children, phaserScene, websocket }) {
  const [unifiedPhase, setUnifiedPhase] = useState('idle')
  const [subPhase, setSubPhase] = useState(null)
  const [progress, setProgress] = useState(0)
  const [cycle, setCycle] = useState(0)
  const [currentTicker, setCurrentTicker] = useState(null)
  const [schedulePhase, setSchedulePhase] = useState('pre_market')
  const [isOffline, setIsOffline] = useState(false)
  const [agentStates, setAgentStates] = useState({})
  const [agentProgress, setAgentProgress] = useState({})

  // Error tracking
  const [errors, setErrors] = useState([])
  const [fallbackMode, setFallbackMode] = useState(null)

  // Animator refs
  const idleEngineRef = useRef(null)
  const dataFetchAnimatorRef = useRef(null)
  const consensusSceneRef = useRef(null)
  const offlineEngineRef = useRef(null)

  // Initialize animators when scene is ready
  useEffect(() => {
    if (!phaserScene) return

    idleEngineRef.current = getIdleBehaviorEngine(phaserScene)
    dataFetchAnimatorRef.current = getDataFetchAnimator(phaserScene)
    consensusSceneRef.current = getConsensusScene(phaserScene)
    offlineEngineRef.current = getOfflineAnimationEngine(phaserScene)

    // Start idle engine
    idleEngineRef.current.start(schedulePhase)

    return () => {
      idleEngineRef.current?.stop()
    }
  }, [phaserScene, schedulePhase])

  // Connection monitoring
  const handleReconnect = useCallback(() => {
    console.log('[AnimationSync] Attempting reconnect...')
    // WebSocket reconnection handled by parent
  }, [])

  const handleOffline = useCallback((info) => {
    console.log('[AnimationSync] Going offline:', info)
    setIsOffline(true)
    offlineEngineRef.current?.enterOfflineMode(info.reason || 'connection_lost')

    // Add error to list
    setErrors(prev => [...prev, {
      id: Date.now(),
      error_type: 'websocket_disconnect',
      message: 'Connection lost',
      timestamp: Date.now(),
    }])
  }, [])

  const handleOnline = useCallback(() => {
    console.log('[AnimationSync] Back online')
    setIsOffline(false)
    offlineEngineRef.current?.exitOfflineMode()
  }, [])

  const {
    isConnected,
    lastPing,
    reconnectAttempts,
    latency
  } = useConnectionMonitor(websocket, handleReconnect, handleOffline, handleOnline)

  // WebSocket message handler
  useEffect(() => {
    if (!websocket) return

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (err) {
        console.error('[AnimationSync] Failed to parse WebSocket message:', err)
      }
    }

    websocket.addEventListener('message', handleMessage)

    return () => {
      websocket.removeEventListener('message', handleMessage)
    }
  }, [websocket])

  // Handle different WebSocket message types
  const handleWebSocketMessage = useCallback((data) => {
    switch (data.type) {
      // Unified phase changes
      case 'unified_phase':
        setUnifiedPhase(data.phase)
        setProgress(data.progress || 0)
        if (data.cycle) setCycle(data.cycle)
        break

      // Sub-phase changes
      case 'sub_phase':
        setSubPhase(data.sub_phase)
        setProgress(data.progress || 0)
        handleSubPhaseAnimation(data)
        break

      // Agent actions
      case 'agent_action':
        handleAgentAction(data)
        break

      // Data fetch events
      case 'data_fetch':
        handleDataFetch(data)
        break

      // Agent progress updates
      case 'agent_progress':
        handleAgentProgress(data)
        break

      // Consensus gathering
      case 'consensus_gathering':
        handleConsensusGathering(data)
        break

      // Error events
      case 'error':
        handleError(data)
        break

      // Idle behavior triggers
      case 'idle_behavior':
        handleIdleBehavior(data)
        break

      // Cycle complete
      case 'cycle_complete':
        setUnifiedPhase('idle')
        setSubPhase(null)
        setProgress(1)
        break

      // God Mode Events
      case 'kill_switch':
        handleKillSwitch(data)
        break

      case 'voice_of_god':
        handleVoiceOfGod(data)
        break

      case 'DATA_ERROR':
        handleDataError(data)
        break

      // Schedule phase changes
      case 'schedule_phase':
        setSchedulePhase(data.phase)
        idleEngineRef.current?.setSchedulePhase(data.phase)
        break

      // Ticker updates
      case 'ticker_update':
        setCurrentTicker(data.ticker)
        break

      default:
        // Legacy message handling
        if (data.phase) {
          // Map legacy phase to unified
          const legacyMap = {
            'regime': 'data_collection',
            'scout': 'data_collection',
            'pre_mortem': 'data_collection',
            'war_room': 'data_collection',
            'agents': 'agent_analysis',
            'inquisition': 'final_decision',
            'oracle': 'final_decision',
            'portfolio': 'final_decision',
          }
          setUnifiedPhase(legacyMap[data.phase] || data.phase)
        }
    }
  }, [])

  // Handle sub-phase animations
  const handleSubPhaseAnimation = useCallback((data) => {
    if (!phaserScene) return

    const subPhaseConfig = {
      'market_analyst': { agent: 'Market Analyst', station: 'scanner' },
      'social_analyst': { agent: 'Social Analyst', station: 'cooler' },
      'news_analyst': { agent: 'News Analyst', station: 'newsstand' },
      'fundamentals_analyst': { agent: 'Fundamentals Analyst', station: 'desk' },
      'bull_researcher': { agent: 'Bull Researcher', station: 'table' },
      'bear_researcher': { agent: 'Bear Researcher', station: 'table' },
      'research_manager': { agent: 'Research Manager', station: 'table' },
      'trader': { agent: 'Trader', station: 'ticker' },
      'aggressive_analyst': { agent: 'Aggressive Analyst', station: 'tv' },
      'conservative_analyst': { agent: 'Conservative Analyst', station: 'tv' },
      'neutral_analyst': { agent: 'Neutral Analyst', station: 'tv' },
      'risk_judge': { agent: 'Risk Judge', station: 'tv' },
    }

    const config = subPhaseConfig[data.sub_phase]
    if (config) {
      phaserScene.moveAgentToStation?.(config.agent, config.station, MovePriority.AUTOMATED, 'ws:subPhase')
    }
  }, [phaserScene])

  // Handle agent actions
  const handleAgentAction = useCallback((data) => {
    if (!phaserScene || !data.agent) return

    const agent = phaserScene.agents?.[data.agent]
    if (!agent) return

    // Move to station if specified
    if (data.station) {
      phaserScene.moveAgentToStation?.(data.agent, data.station, MovePriority.AUTOMATED, 'ws:agentAction')
    }

    // Play animation if specified
    if (data.animation) {
      const key = `agent_${data.agent.toLowerCase()}`
      agent.play(`${key}_${data.animation}`, true)
    }

    // Update agent state
    setAgentStates(prev => ({
      ...prev,
      [data.agent]: {
        status: data.action,
        station: data.station,
        ticker: data.ticker,
      }
    }))
  }, [phaserScene])

  // Handle data fetch animations
  const handleDataFetch = useCallback(async (data) => {
    if (!dataFetchAnimatorRef.current || !data.agent) return

    switch (data.status) {
      case 'start':
        await dataFetchAnimatorRef.current.animateDataFetchStart(
          data.agent,
          data.data_type,
          data.ticker
        )
        break
      case 'progress':
        await dataFetchAnimatorRef.current.animateDataFetchProgress(
          data.agent,
          data.progress,
          data.stage
        )
        break
      case 'complete':
        await dataFetchAnimatorRef.current.animateDataFetchComplete(
          data.agent,
          data.summary
        )
        break
      case 'error':
        await dataFetchAnimatorRef.current.animateDataFetchError(
          data.agent,
          data.error
        )
        break
    }
  }, [])

  // Handle agent progress updates
  const handleAgentProgress = useCallback((data) => {
    setAgentProgress(prev => ({
      ...prev,
      [data.agent]: {
        progress: data.progress,
        stage: data.stage,
        reasoning: data.reasoning,
      }
    }))
  }, [])

  // Handle consensus gathering
  const handleConsensusGathering = useCallback(async (data) => {
    if (!consensusSceneRef.current) return
    await consensusSceneRef.current.gatherForConsensus(data.opinions || {})
  }, [])

  // Handle errors
  const handleError = useCallback((data) => {
    // Add error to tracking
    const error = {
      id: Date.now(),
      error_type: data.error_type,
      message: data.message,
      service: data.service,
      agent: data.agent,
      ticker: data.ticker,
      fallback: data.fallback,
      timestamp: data.timestamp || Date.now(),
    }
    setErrors(prev => [...prev.slice(-9), error]) // Keep last 10 errors

    // Set fallback mode
    if (data.fallback) {
      setFallbackMode(data.fallback)
    }

    if (data.error_type === 'connection_lost' || data.error_type === 'no_internet') {
      setIsOffline(true)
      offlineEngineRef.current?.enterOfflineMode(data.error_type)
    } else {
      // Play error animation on specific agent
      if (data.agent) {
        offlineEngineRef.current?.playErrorAnimation(data.agent, data.error_type)
      }
    }
  }, [])

  // Error recovery
  const recoverFromError = useCallback(async (error, action) => {
    console.log('[AnimationSync] Recovering from error:', error.error_type, action)

    switch (action) {
      case 'retry':
        // Clear error and retry
        setErrors(prev => prev.filter(e => e.id !== error.id))
        break
      case 'fallback':
        setFallbackMode('heuristic')
        break
      case 'reconnect':
        handleReconnect()
        break
      case 'dismiss':
        setErrors(prev => prev.filter(e => e.id !== error.id))
        break
    }
  }, [handleReconnect])

  const dismissError = useCallback((errorId) => {
    setErrors(prev => prev.filter(e => e.id !== errorId))
  }, [])

  // God Mode Handlers
  const handleKillSwitch = useCallback((data) => {
    console.warn('[AnimationSync] KILL SWITCH ACTIVATED', data.reason)
    setUnifiedPhase('final_decision')
    setSubPhase('portfolio')
    // Set all agents to SELL status visually
    setAgentStates(prev => {
      const newStates = { ...prev }
      Object.keys(newStates).forEach(agent => {
        newStates[agent] = { ...newStates[agent], status: 'SELL' }
      })
      return newStates
    })
    // Add critical error alert
    setErrors(prev => [...prev.slice(-9), {
      id: Date.now(),
      error_type: 'kill_switch',
      message: data.reason || 'DIRECTOR INTERVENTION: LIQUIDATING',
      timestamp: data.timestamp || Date.now(),
    }])
  }, [])

  const handleVoiceOfGod = useCallback(async (data) => {
    console.log('[AnimationSync] VOICE OF GOD', data.message)
    // Update Oracle agent explicitly with the message
    setAgentProgress(prev => ({
      ...prev,
      ['Risk Judge']: {
        progress: 1.0,
        stage: 'Voice of God',
        reasoning: data.message,
      }
    }))
    setAgentStates(prev => ({
      ...prev,
      ['Risk Judge']: { ...prev['Risk Judge'], status: 'HOLD' }
    }))
  }, [])

  const handleDataError = useCallback((data) => {
    console.error('[AnimationSync] DATA ERROR', data)
    const bearAgent = 'Bear Researcher'
    offlineEngineRef.current?.playErrorAnimation(bearAgent, 'data_error')

    setAgentProgress(prev => ({
      ...prev,
      [bearAgent]: {
        progress: 1.0,
        stage: 'Data Error',
        reasoning: `Data feed is corrupted. ${data.message || 'These numbers are garbage. Next!'}`,
      }
    }))

    // Also track in standard error list
    setErrors(prev => [...prev.slice(-9), {
      id: Date.now(),
      error_type: 'data_error',
      message: data.message || 'Corrupted data feed',
      agent: bearAgent,
      ticker: data.ticker,
      timestamp: Date.now(),
    }])
  }, [])

  // Handle idle behavior triggers
  const handleIdleBehavior = useCallback((data) => {
    if (!idleEngineRef.current) return

    switch (data.behavior) {
      case 'wander':
        // Let idle engine handle wandering
        break
      case 'sleep':
        // Night shift mode
        break
      case 'gossip':
        // Gossip mode
        break
      default:
        idleEngineRef.current.setSchedulePhase(data.schedule_phase || schedulePhase)
    }
  }, [schedulePhase])

  // Public API
  const value = {
    // State
    unifiedPhase,
    subPhase,
    progress,
    cycle,
    currentTicker,
    schedulePhase,
    isOffline,
    agentStates,
    agentProgress,

    // Connection state
    isConnected,
    lastPing,
    reconnectAttempts,
    latency,

    // Error state
    errors,
    fallbackMode,

    // Setters
    setUnifiedPhase,
    setSubPhase,
    setProgress,
    setCycle,
    setCurrentTicker,
    setSchedulePhase,

    // Animators
    idleEngine: idleEngineRef.current,
    dataFetchAnimator: dataFetchAnimatorRef.current,
    consensusScene: consensusSceneRef.current,
    offlineEngine: offlineEngineRef.current,
    gossipEngine: null,

    // Error handling
    recoverFromError,
    dismissError,

    // Helpers
    getPhaseInfo: (phaseId) => UNIFIED_PHASES.find(p => p.id === phaseId),
    getSubPhaseInfo: (phaseId, subPhaseId) => {
      const phase = UNIFIED_PHASES.find(p => p.id === phaseId)
      return phase?.subPhases?.find(s => s.id === subPhaseId)
    },
  }

  return (
    <AnimationSyncContext.Provider value={value}>
      {children}
    </AnimationSyncContext.Provider>
  )
}

export function useAnimationSync() {
  const context = useContext(AnimationSyncContext)
  if (!context) {
    throw new Error('useAnimationSync must be used within AnimationSyncProvider')
  }
  return context
}

export default AnimationSyncContext
