// Trading Floor Context
import { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import PropTypes from 'prop-types'
import { buildAgentNameMap, AGENTS as STATIC_AGENTS, AGENT_NAME_MAP as STATIC_NAME_MAP, setGlobalAgents, setGlobalAgentNameMap } from '../utils/constants'
import { setAllAgents } from '../config/stepScenes'

const TradingFloorContext = createContext(null)

// Load saved broadcast settings from localStorage
const loadBroadcastSettings = () => {
  try {
    const saved = localStorage.getItem('broadcastSettings')
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        hideNews: parsed.hideNews ?? true,
        hideCycle: parsed.hideCycle ?? true,
        hideLeftSidebar: true,
        hideRightSidebar: !!parsed.hideRightSidebar,
        showPerformanceView: !!parsed.showPerformanceView,
        lightMode: parsed.lightMode || 'night',
        marqueeSpeed: parsed.marqueeSpeed || 120,
        newsScrollSpeed: parsed.newsScrollSpeed || 120
      }
    }
  } catch (e) {
    console.error('Failed to load broadcast settings:', e)
  }
  return {
    hideNews: true,
    hideCycle: true,
    hideLeftSidebar: true,
    hideRightSidebar: false,
    showPerformanceView: false,
    lightMode: 'night',
    marqueeSpeed: 120,
    newsScrollSpeed: 120
  }
}

const savedSettings = loadBroadcastSettings()

const initialState = {
  portfolio: { total_value: 1100000, cash: 1100000, daily_pnl: 0, performance_vs_spy: 0, positions: {} },
  logs: [],
  spyData: { price: 0, alpha: 0, beating: false },
  schedulePhase: 'pre_market',
  connected: false,
  backendHealth: {
    status: 'starting',
    activeHost: null,
    currentMessage: 'Waiting for backend readiness probe.',
    lastFailureReason: null,
    lastFailureAt: null,
    lastHealthyAt: null,
  },
  activeDialogue: { agent: null, text: null, portrait: null, type: 'system' },
  news: [],
  streamedNews: [], // News streamed from admin panel
  liveNews: [], // Live news feed for Zone 5 sidebar
  sentiment: { bull_pct: 0.5, bear_pct: 0.5, total_votes: 0, sentiment: 'Neutral' },
  marqueeSpeed: savedSettings.marqueeSpeed || 120, // Marquee scroll speed in seconds (higher = slower)
  newsScrollSpeed: savedSettings.newsScrollSpeed || 120, // News panel auto-scroll speed in seconds (higher = slower)
  marqueeText: '', // Marquee text content for Zone 1
  activeScene: null, // Current scene being displayed
  sceneControl: null, // Control commands for active scene (pause/skip/abort)
  sceneQueue: [], // Queued scenes from scriptwriter
  memeMode: false, // Toggle for funny meme portraits
  agents: null, // Dynamic agent config from API (null = not loaded)
  agentNameMap: STATIC_NAME_MAP, // Dynamic name mapping
  spyBenchmark: { aggregate: { fund_return: 0, spy_return: 0, alpha: 0 }, by_position: {} }, // SPY benchmark from entry dates
  agentStates: {}, // Live agent states from backend
  // Scene Settings
  hideNews: savedSettings.hideNews ?? true, // Default to true if not saved
  hideCycle: savedSettings.hideCycle ?? true, // Default to true if not saved
  hideLeftSidebar: true,
  hideRightSidebar: !!savedSettings.hideRightSidebar,
  showPerformanceView: !!savedSettings.showPerformanceView,
  lightMode: savedSettings.lightMode || 'night', // 'day' or 'night'
  // Real-time Pipeline & Analytics
  pipelineState: {
    phase: 'idle',
    current_ticker: null,
    history: [],
    research_depth: null,
    ta_background_profiles: {},
    ta_foreground_override: {},
  },
  zoneEvents: [],
  closedTrades: [],
  executionHistory: [],
  analytics: { win_rate: 0, total_trades: 0, total_value: 1100000, daily_pnl: 0 },
  // TradingAgents run stats (for TAStatusBar)
  taRunStats: {
    runId: null,
    agentsCompleted: 0,
    agentsTotal: 12,
    completedAgents: {},
    llmCalls: 0,
    toolCalls: 0,
    tokensUp: 0,
    tokensDown: 0,
    tokenTelemetrySeen: false,
    reportsCompleted: 0,
    reportsTotal: 12,
    reports: {},
    reportSectionsCompleted: 0,
    reportSectionsTotal: 12,
    reportSections: {},
    startTime: null,
    endTime: null,
    decision: null,
    elapsed: null,
    running: false,
    completed: false,
    status: 'idle',
    attempt: 1,
    maxAttempts: 1,
    retrying: false,
    invalidAgents: [],
    upstreamGeneratedAt: null,
  },
  liveTaReports: {},
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_PORTFOLIO':
      return { ...state, portfolio: typeof action.payload === 'function' ? action.payload(state.portfolio) : action.payload }
    case 'ADD_LOG':
      return { ...state, logs: [...state.logs.slice(-499), action.payload] }
    case 'ADD_NEWS':
      return { ...state, news: [action.payload, ...state.news].slice(0, 10) }
    case 'SET_LOGS':
      return { ...state, logs: action.payload }
    case 'SET_SCHEDULE':
      return { ...state, schedulePhase: action.payload }
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload }
    case 'SET_BACKEND_HEALTH': {
      const nextBackendHealth =
        typeof action.payload === 'function'
          ? action.payload(state.backendHealth)
          : action.payload
      return {
        ...state,
        backendHealth: {
          ...state.backendHealth,
          ...(nextBackendHealth || {}),
        },
      }
    }
    case 'SET_SPY_DATA':
      return { ...state, spyData: action.payload }
    case 'SET_DIALOGUE':
      return { ...state, activeDialogue: action.payload }
    case 'SET_SENTIMENT':
      return { ...state, sentiment: action.payload }
    case 'ADD_STREAMED_NEWS':
      return { ...state, streamedNews: [action.payload, ...state.streamedNews].slice(0, 20) }
    case 'CLEAR_STREAMED_NEWS':
      return { ...state, streamedNews: [] }
    case 'SET_MARQUEE_SPEED':
      return { ...state, marqueeSpeed: action.payload }
    case 'SET_NEWS_SCROLL_SPEED':
      return { ...state, newsScrollSpeed: action.payload }
    case 'SET_ACTIVE_SCENE':
      return { ...state, activeScene: action.payload }
    case 'SET_SCENE_CONTROL':
      return { ...state, sceneControl: action.payload }
    case 'SET_MEME_MODE':
      return { ...state, memeMode: action.payload }
    case 'SET_LIGHT_MODE':
      return { ...state, lightMode: action.payload }
    case 'CLEAR_SCENE':
      return { ...state, activeScene: null }
    case 'SET_MARQUEE_TEXT':
      return { ...state, marqueeText: action.payload }
    case 'APPEND_LIVE_NEWS':
      // Keep only last 10 articles to prevent memory leaks
      const newLiveNews = [...action.payload, ...state.liveNews].slice(0, 10)
      return { ...state, liveNews: newLiveNews }
    case 'CLEAR_ACTIVE_SCENE':
      return { ...state, activeScene: null }
    case 'SET_AGENTS':
      return { ...state, agents: action.payload.agents, agentNameMap: action.payload.nameMap }
    case 'SET_AGENT_STATES':
      return { ...state, agentStates: typeof action.payload === 'function' ? action.payload(state.agentStates) : action.payload }
    case 'SET_SPY_BENCHMARK':
      return { ...state, spyBenchmark: action.payload }
    case 'SET_HIDE_NEWS':
      return { ...state, hideNews: action.payload }
    case 'SET_HIDE_CYCLE':
      return { ...state, hideCycle: action.payload }
    case 'SET_HIDE_LEFT_SIDEBAR':
      return { ...state, hideLeftSidebar: true }
    case 'SET_HIDE_RIGHT_SIDEBAR':
      return { ...state, hideRightSidebar: action.payload }
    case 'SET_SHOW_PERFORMANCE_VIEW':
      return { ...state, showPerformanceView: action.payload }
    case 'SET_PIPELINE_STATE': {
      const psUpdate = typeof action.payload === 'function' ? action.payload(state.pipelineState) : action.payload
      return { ...state, pipelineState: { ...state.pipelineState, ...psUpdate } }
    }
    case 'ADD_ZONE_EVENT':
      return { ...state, zoneEvents: [action.payload, ...state.zoneEvents].slice(0, 50) }
    case 'SET_ZONE_EVENTS':
      return { ...state, zoneEvents: typeof action.payload === 'function' ? action.payload(state.zoneEvents) : action.payload }
    case 'SET_EXECUTION_HISTORY':
      return { ...state, executionHistory: action.payload }
    case 'SET_CLOSED_TRADES':
      // Never overwrite with empty array if we already have data
      if (!action.payload || action.payload.length === 0) {
        return state  // Keep existing data
      }
      return { ...state, closedTrades: action.payload }
    case 'SET_ANALYTICS':
      return { ...state, analytics: action.payload }
    case 'SET_FROM_STORAGE':
      return { ...state, ...action.payload }
    case 'SET_TA_RUN_STATS':
      return { ...state, taRunStats: typeof action.payload === 'function' ? action.payload(state.taRunStats) : { ...state.taRunStats, ...action.payload } }
    case 'RESET_TA_RUN_STATS':
      return { ...state, taRunStats: { ...initialState.taRunStats, ...action.payload } }
    case 'SET_LIVE_TA_REPORTS':
      return {
        ...state,
        liveTaReports: typeof action.payload === 'function'
          ? action.payload(state.liveTaReports)
          : (action.payload || {}),
      }
    default:
      return state
  }
}

export function TradingFloorProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  const addLog = useCallback((type, data) => {
    // Trust upstream filtering from App.jsx - just add the log
    const entry = typeof data === 'object' 
      ? { ...data, type, timestamp: new Date().toISOString() }
      : { type, message: data, timestamp: new Date().toISOString() }
    dispatch({ type: 'ADD_LOG', payload: entry })
  }, [])

  const addNews = useCallback((headline) => {
    dispatch({ type: 'ADD_NEWS', payload: headline })
  }, [])

  const setPortfolio = useCallback((portfolio) => {
    dispatch({ type: 'SET_PORTFOLIO', payload: portfolio })
  }, [])

  const setSchedulePhase = useCallback((phase) => {
    dispatch({ type: 'SET_SCHEDULE', payload: phase })
  }, [])

  const setConnected = useCallback((connected) => {
    dispatch({ type: 'SET_CONNECTED', payload: connected })
  }, [])

  const setBackendHealth = useCallback((backendHealth) => {
    dispatch({ type: 'SET_BACKEND_HEALTH', payload: backendHealth })
  }, [])

  const setSpyData = useCallback((spyData) => {
    dispatch({ type: 'SET_SPY_DATA', payload: spyData })
  }, [])

  const setDialogue = useCallback((agent, text, type = 'system') => {
    dispatch({ type: 'SET_DIALOGUE', payload: { agent, text, type } })
  }, [])

  const setSentiment = useCallback((sentiment) => {
    dispatch({ type: 'SET_SENTIMENT', payload: sentiment })
  }, [])

  const addStreamedNews = useCallback((newsItem) => {
    dispatch({ type: 'ADD_STREAMED_NEWS', payload: newsItem })
  }, [])

  const clearStreamedNews = useCallback(() => {
    dispatch({ type: 'CLEAR_STREAMED_NEWS' })
  }, [])

  const setActiveScene = useCallback((scene) => {
    dispatch({ type: 'SET_ACTIVE_SCENE', payload: scene })
  }, [])

  const setSceneControl = useCallback((control) => {
    dispatch({ type: 'SET_SCENE_CONTROL', payload: control })
  }, [])

  const clearScene = useCallback(() => {
    dispatch({ type: 'CLEAR_SCENE' })
  }, [])

  const setMemeMode = useCallback((active) => {
    dispatch({ type: 'SET_MEME_MODE', payload: active })
  }, [])

  const setMarqueeText = useCallback((text) => {
    dispatch({ type: 'SET_MARQUEE_TEXT', payload: text })
  }, [])

  const appendLiveNews = useCallback((articles) => {
    dispatch({ type: 'APPEND_LIVE_NEWS', payload: articles })
  }, [])

  const setAgents = useCallback((agents, nameMap) => {
    dispatch({ type: 'SET_AGENTS', payload: { agents, nameMap } })
  }, [])

  const setAgentStates = useCallback((agentStates) => {
    dispatch({ type: 'SET_AGENT_STATES', payload: agentStates || {} })
  }, [])

  const setSpyBenchmark = useCallback((benchmark) => {
    dispatch({ type: 'SET_SPY_BENCHMARK', payload: benchmark })
  }, [])

  const updatePersistentSetting = (key, value) => {
    try {
      const current = loadBroadcastSettings()
      const updated = { ...current, [key]: value }
      localStorage.setItem('broadcastSettings', JSON.stringify(updated))
      const actionType = `SET_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`
      dispatch({ type: actionType, payload: value })
    } catch (e) {
      console.error('Failed to update persistent setting:', e)
    }
  }

  const setHideNews = useCallback((val) => updatePersistentSetting('hideNews', val), [])
  const setHideCycle = useCallback((val) => updatePersistentSetting('hideCycle', val), [])
  const setHideLeftSidebar = useCallback(() => updatePersistentSetting('hideLeftSidebar', true), [])
  const setHideRightSidebar = useCallback((val) => updatePersistentSetting('hideRightSidebar', val), [])
  const setShowPerformanceView = useCallback((val) => updatePersistentSetting('showPerformanceView', val), [])
  const setLightMode = useCallback((val) => updatePersistentSetting('lightMode', val), [])
  const setMarqueeSpeed = useCallback((speed) => updatePersistentSetting('marqueeSpeed', speed), [])
  const setNewsScrollSpeed = useCallback((speed) => updatePersistentSetting('newsScrollSpeed', speed), [])

  // Sync state from other tabs
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'broadcastSettings' && e.newValue) {
        try {
          const newSettings = JSON.parse(e.newValue)
          dispatch({ 
            type: 'SET_FROM_STORAGE', 
            payload: {
              hideNews: newSettings.hideNews ?? true,
              hideCycle: newSettings.hideCycle ?? true,
              hideLeftSidebar: true,
              hideRightSidebar: !!newSettings.hideRightSidebar,
              showPerformanceView: !!newSettings.showPerformanceView,
              lightMode: newSettings.lightMode || 'night',
              marqueeSpeed: newSettings.marqueeSpeed || 120,
              newsScrollSpeed: newSettings.newsScrollSpeed || 120
            }
          })
        } catch (err) {
          console.error('Failed to sync settings from storage:', err)
        }
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const refreshAgents = useCallback(async () => {
    try {
      const res = await fetch('/trading-floor/agents/canvas-config')
      if (!res.ok) {
        console.warn('Failed to refresh agents from API')
        return false
      }
      const data = await res.json()
      
      // Convert to displayName-keyed format
      const agents = {}
      for (const [shortName, cfg] of Object.entries(data.agents || {})) {
        if (cfg.active) {
          agents[cfg.displayName] = {
            position: cfg.position,
            personality: cfg.personality,
            color: cfg.color,
            shortName: shortName
          }
        }
      }
      
      // Build name map
      const nameMap = buildAgentNameMap(data.agents)
      
      // Sync with stepScenes global list
      if (data.short_names) {
        setAllAgents(data.short_names)
      }

      setGlobalAgents(agents)
      setGlobalAgentNameMap(nameMap)
      setAgents(agents, nameMap)
      return true
    } catch (err) {
      console.warn('Error refreshing agents:', err)
      return false
    }
  }, [setAgents])

  const getAgents = useCallback(() => {
    return state.agents || STATIC_AGENTS
  }, [state.agents])

  const getAgentNameMap = useCallback(() => {
    return state.agentNameMap || STATIC_NAME_MAP
  }, [state.agentNameMap])

  const setPipelineState = useCallback((pipelineState) => {
    dispatch({ type: 'SET_PIPELINE_STATE', payload: pipelineState })
  }, [])

  const addZoneEvent = useCallback((event) => {
    dispatch({ type: 'ADD_ZONE_EVENT', payload: event })
  }, [])

  const setZoneEvents = useCallback((events) => {
    dispatch({ type: 'SET_ZONE_EVENTS', payload: events })
  }, [])

  const setExecutionHistory = useCallback((history) => {
    dispatch({ type: 'SET_EXECUTION_HISTORY', payload: history })
  }, [])

  const setClosedTrades = useCallback((trades) => {
    dispatch({ type: 'SET_CLOSED_TRADES', payload: trades })
  }, [])

  const setAnalytics = useCallback((analytics) => {
    dispatch({ type: 'SET_ANALYTICS', payload: analytics })
  }, [])

  const setTaRunStats = useCallback((stats) => {
    dispatch({ type: 'SET_TA_RUN_STATS', payload: stats })
  }, [])

  const resetTaRunStats = useCallback((overrides) => {
    dispatch({ type: 'RESET_TA_RUN_STATS', payload: overrides })
  }, [])

  const setLiveTaReports = useCallback((reports) => {
    dispatch({ type: 'SET_LIVE_TA_REPORTS', payload: reports })
  }, [])

  return (
    <TradingFloorContext.Provider value={{
      state,
      dispatch,
      addLog,
      setPortfolio,
      setSchedulePhase,
      setConnected,
      setBackendHealth,
      setSpyData,
      setDialogue,
      addNews,
      setSentiment,
      addStreamedNews,
      clearStreamedNews,
      setMarqueeSpeed,
      setNewsScrollSpeed,
      setActiveScene,
      setSceneControl,
      clearScene,
      setMemeMode,
      setMarqueeText,
      appendLiveNews,
    setAgents,
    setAgentStates,
      refreshAgents,
      getAgents,
      getAgentNameMap,
      setSpyBenchmark,
      setHideNews,
      setHideCycle,
      setHideLeftSidebar,
      setHideRightSidebar,
      setShowPerformanceView,
      setLightMode,
      setPipelineState,
      addZoneEvent,
      setExecutionHistory,
      setClosedTrades,
      setAnalytics,
      setZoneEvents,
      setTaRunStats,
      resetTaRunStats,
      setLiveTaReports
    }}>
      {children}
    </TradingFloorContext.Provider>
  )
}

TradingFloorProvider.propTypes = {
  children: PropTypes.node.isRequired
}

export function useTradingFloor() {
  const context = useContext(TradingFloorContext)
  if (!context) {
    throw new Error('useTradingFloor must be used within a TradingFloorProvider')
  }
  return context
}
