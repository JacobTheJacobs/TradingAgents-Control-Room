// PipelineScenesPanel.jsx - Admin panel for configuring pipeline step scenes
// Allows manual triggering and configuration of each phase's animation scene

import { useState, useEffect } from 'react'
import { STEP_SCENES, LOCATIONS, AnimState, setAllAgents } from '../../config/stepScenes'
import './PipelineScenesPanel.css'
import {
  normalizeTradingAgentName,
  TRADING_AGENT_NAMES,
  TRADING_AGENT_TIMELINE_SCENES,
  TRADING_AGENT_TIMELINE_SCENE_BY_KEY,
} from '../../config/tradingAgentsRoster'
import { TILE_TYPES } from '../../utils/constants'
import { ShowrunnerPanel } from './ShowrunnerPanel'

const API_BASE = ''  // Use relative paths to leverage Vite proxy

// Animation options categorized for better UX
const ANIMATION_OPTIONS = [
  { label: '--- Professional ---', value: '__professional_header', disabled: true },
  { value: AnimState.IDLE, label: 'Standard Idle' },
  { value: AnimState.TALK, label: 'Speaking / Debating' },
  { value: AnimState.READ, label: 'Reading Documents' },
  { value: AnimState.SIT_TYPE, label: 'Working at Terminal' },
  { value: AnimState.SIT_BACK, label: 'Relaxed / Observing' },
  { value: 'think', label: 'Deep Thought' },
  { value: AnimState.POINT, label: 'Pointing at Chart' },
  
  { label: '--- Trading Emotes ---', value: '__trading_header', disabled: true },
  { value: AnimState.BUY, label: '💰 Smash Buy' },
  { value: AnimState.SELL, label: '🔥 Panic Sell' },
  { value: AnimState.CHEER, label: '🚀 Mooning / Cheer' },
  { value: AnimState.LOSE, label: '📉 Losing Money' },
  { value: AnimState.FACEPALM, label: '🤦 Facepalm' },
  { value: AnimState.ARGUE, label: '😤 Heated Argument' },
  { value: AnimState.HODL, label: '💎 Diamond Hands' },
  { value: AnimState.REKT, label: '💀 Rekt / Margin Call' },
  { value: AnimState.COPIUM, label: '🚬 Copium Inhale' },
  
  { label: '--- Meme Styles ---', value: '__meme_header', disabled: true },
  { value: AnimState.FATFINGER, label: '🖐️ Fat Finger' },
  { value: AnimState.LEVERAGE, label: '⚖️ 100x Leverage' },
  { value: AnimState.TENDIES, label: '🍗 Tendies Time' },
  { value: AnimState.WHALE, label: '🐋 Whale Attack' },
  { value: AnimState.FED, label: '🖨️ Fed Printing' },
  { value: AnimState.BRRR, label: '💸 Money Brrr' },
  { value: AnimState.ROCKET, label: '🏎️ Wen Lambo' },
  { value: AnimState.RUGPULL, label: '🧹 Rug Pull' },
]



// Location options for dropdown
const LOCATION_OPTIONS = [
  { value: LOCATIONS.DESK, label: 'Desks' },
  { value: LOCATIONS.COOLER, label: 'Water Cooler' },
  { value: LOCATIONS.TABLE, label: 'Center Table' },
  { value: LOCATIONS.TV, label: 'TV Area' },
  { value: LOCATIONS.SCANNER, label: 'Scanner' },
  { value: LOCATIONS.CENTER, label: 'Center Stage' },
  { value: LOCATIONS.NEWSSTAND, label: 'Newsstand' },
  { value: LOCATIONS.WINDOW, label: 'Window' },
]

const PATH_OPTIONS = [
  { value: 'direct', label: 'Direct' },
  { value: 'detour', label: 'Detour' },
  { value: 'loop', label: 'Loop' },
  { value: 'idle', label: 'Idle' },
]

const LOCATION_TILE_TYPES = {
  [LOCATIONS.DESK]: TILE_TYPES.DESK,
  [LOCATIONS.COOLER]: TILE_TYPES.COOLER,
  [LOCATIONS.TABLE]: TILE_TYPES.TABLE,
  [LOCATIONS.TV]: TILE_TYPES.TV,
  [LOCATIONS.SCANNER]: TILE_TYPES.SCANNER,
  [LOCATIONS.CENTER]: TILE_TYPES.TABLE,
  [LOCATIONS.NEWSSTAND]: TILE_TYPES.NEWSSTAND,
  [LOCATIONS.WINDOW]: TILE_TYPES.WINDOW,
  [LOCATIONS.TICKER]: TILE_TYPES.TICKER,
}

const TIMELINE_SCENE_SPECS = TRADING_AGENT_TIMELINE_SCENES

const isTimelineSceneKey = (key) => Boolean(TRADING_AGENT_TIMELINE_SCENE_BY_KEY[key])

const isEmptyObject = (value) => !value || Object.keys(value || {}).length === 0

const isBrokenTimelineOverride = (key, config = {}) => (
  isTimelineSceneKey(key) &&
  config?.__explicit === true &&
  config?.__allow_empty_agents !== true &&
  (!Array.isArray(config.agents) || config.agents.length === 0) &&
  isEmptyObject(config.animations) &&
  isEmptyObject(config.stations) &&
  isEmptyObject(config.paths)
)

const buildTimelineMovementPlan = (scene = {}) => {
  const agents = normalizeSceneAgents(scene.agents, TRADING_AGENT_NAMES)
  return agents.map((agent) => ({
    agent,
    from: 'home',
    to: scene.stations?.[agent] || scene.location || LOCATIONS.DESK,
    mode: scene.paths?.[agent] || 'direct',
  }))
}

const buildTimelineSceneSaveConfig = (scene = {}) => {
  const agents = normalizeSceneAgents(scene.agents, TRADING_AGENT_NAMES)
  const explicitStationOverrides = normalizeSceneAgents(scene.__station_overrides, agents)
  const animations = {}
  const stations = {}
  const paths = {}

  agents.forEach((agent) => {
    animations[agent] = scene.animations?.[agent] || scene.animations?.default || AnimState.IDLE
    stations[agent] = explicitStationOverrides.includes(agent)
      ? (scene.stations?.[agent] || scene.stations?.default || scene.location || LOCATIONS.DESK)
      : (scene.location || scene.stations?.default || LOCATIONS.DESK)
    paths[agent] = scene.paths?.[agent] || scene.paths?.default || 'direct'
  })

  return {
    location: scene.location || LOCATIONS.DESK,
    agents,
    animations,
    stations,
    paths,
    __station_overrides: explicitStationOverrides,
    __explicit: true,
    __allow_empty_agents: agents.length === 0,
  }
}

const normalizeBehaviorDefaults = (defaults = {}) => {
  const next = {}
  Object.entries(defaults || {}).forEach(([agentKey, cfg]) => {
    const canonicalName = normalizeTradingAgentName(cfg?.displayName || agentKey)
    if (!canonicalName) return
    next[canonicalName] = {
      default_animation: cfg?.default_animation || AnimState.IDLE,
      default_station: cfg?.default_station,
      default_path: cfg?.default_path || 'direct',
    }
  })
  return next
}

const normalizeSceneAgents = (agents, canonicalAgents = TRADING_AGENT_NAMES) => {
  const seen = new Set()
  ;(agents || []).forEach((agent) => {
    const canonical = normalizeTradingAgentName(agent)
    if (canonical && canonicalAgents.includes(canonical)) {
      seen.add(canonical)
    }
  })
  return canonicalAgents.filter((agent) => seen.has(agent))
}

const normalizeSceneStations = (stations, agents) => {
  const next = {}
  const validAgents = new Set(agents)
  Object.entries(stations || {}).forEach(([agent, station]) => {
    if (agent === 'default') {
      next.default = station
      return
    }
    const canonical = normalizeTradingAgentName(agent)
    if (canonical && validAgents.has(canonical)) {
      next[canonical] = station
    }
  })
  return next
}

const normalizeSceneAnimations = (animations, agents) => {
  const next = {}
  const validAgents = new Set(agents)
  Object.entries(animations || {}).forEach(([agent, animation]) => {
    if (agent === 'default') {
      next.default = animation
      return
    }
    const canonical = normalizeTradingAgentName(agent)
    if (canonical && validAgents.has(canonical)) {
      next[canonical] = animation
    }
  })
  return next
}

const normalizeScenePaths = (paths, agents) => {
  const next = {}
  const validAgents = new Set(agents)
  Object.entries(paths || {}).forEach(([agent, path]) => {
    if (agent === 'default') {
      next.default = path
      return
    }
    const canonical = normalizeTradingAgentName(agent)
    if (canonical && validAgents.has(canonical)) {
      next[canonical] = path
    }
  })
  return next
}

const normalizeSceneConfig = (scene, canonicalAgents = TRADING_AGENT_NAMES) => {
  const agents = normalizeSceneAgents(scene?.agents, canonicalAgents)
  return {
    ...scene,
    agents,
    animations: normalizeSceneAnimations(scene?.animations, agents),
    stations: normalizeSceneStations(scene?.stations, agents),
    paths: normalizeScenePaths(scene?.paths, agents),
    __station_overrides: normalizeSceneAgents(scene?.__station_overrides, agents),
    __allow_empty_agents: scene?.__allow_empty_agents === true,
  }
}

const countTilesByType = (mapData = []) => {
  const counts = {}
  if (!Array.isArray(mapData)) return counts
  mapData.forEach((row) => {
    if (!Array.isArray(row)) return
    row.forEach((tile) => {
      const key = Number(tile)
      counts[key] = (counts[key] || 0) + 1
    })
  })
  return counts
}

const hasStationTiles = (station, tileCounts = {}) => {
  const tileType = LOCATION_TILE_TYPES[station]
  if (tileType == null) return true
  return Boolean(tileCounts[tileType])
}

const getNearestWalkableFallback = (mapData = []) => {
  if (!Array.isArray(mapData)) return null
  for (let r = 0; r < mapData.length; r++) {
    const row = mapData[r]
    if (!Array.isArray(row)) continue
    for (let c = 0; c < row.length; c++) {
      const tile = Number(row[c])
      if (
        tile === TILE_TYPES.FLOOR ||
        tile === TILE_TYPES.RUG ||
        tile === TILE_TYPES.MONEY ||
        tile === TILE_TYPES.DOOR
      ) {
        return { c, r }
      }
    }
  }
  return null
}

const resolveSceneStationsForMap = (scene = {}, mapData = []) => {
  const tileCounts = countTilesByType(mapData)
  const fallbackLocation = hasStationTiles(scene.location, tileCounts) ? scene.location : null
  const deskFallback = hasStationTiles(LOCATIONS.DESK, tileCounts) ? LOCATIONS.DESK : null
  const floorFallback = getNearestWalkableFallback(mapData)
  const stations = {}
  const warnings = []
  const directTargets = {}

  ;(scene.agents || []).forEach((agent) => {
    const requested = scene.stations?.[agent] || scene.location || LOCATIONS.DESK
    if (hasStationTiles(requested, tileCounts)) {
      stations[agent] = requested
      return
    }

    if (fallbackLocation) {
      stations[agent] = fallbackLocation
      warnings.push(`${agent} -> ${requested} missing; using ${fallbackLocation}`)
      return
    }

    if (deskFallback) {
      stations[agent] = deskFallback
      warnings.push(`${agent} -> ${requested} missing; using ${deskFallback}`)
      return
    }

    stations[agent] = 'direct'
    if (floorFallback) directTargets[agent] = floorFallback
    warnings.push(`${agent} -> ${requested} missing; using nearest walkable floor`)
  })

  return { stations, warnings, directTargets }
}

const resolveSceneConfig = (phaseKey, override, behaviorDefaults = {}) => {
  const baseScene = STEP_SCENES[phaseKey]
  const normalizedOverride = normalizeSceneConfig(override || {}, TRADING_AGENT_NAMES)
  const sceneAgents = Array.isArray(normalizedOverride.agents) && normalizedOverride.agents.length > 0
    ? normalizedOverride.agents
    : baseScene.agents
  const agents = normalizeSceneAgents(sceneAgents, TRADING_AGENT_NAMES)
  const animations = {}
  const stations = {}
  const paths = {}

  agents.forEach((agent) => {
    const behavior = behaviorDefaults[agent] || {}
    animations[agent] =
      normalizedOverride.animations?.[agent] ||
      normalizedOverride.animations?.default ||
      behavior.default_animation ||
      baseScene.animations?.[agent] ||
      baseScene.animations?.default ||
      AnimState.IDLE
    stations[agent] =
      normalizedOverride.stations?.[agent] ||
      normalizedOverride.stations?.default ||
      behavior.default_station ||
      baseScene.stations?.[agent] ||
      baseScene.stations?.default ||
      baseScene.location
    paths[agent] =
      normalizedOverride.paths?.[agent] ||
      normalizedOverride.paths?.default ||
      behavior.default_path ||
      baseScene.paths?.[agent] ||
      baseScene.paths?.default ||
      'direct'
  })

  return {
    ...baseScene,
    ...normalizedOverride,
    agents,
    location: normalizedOverride.location || (agents.length === 1 ? stations[agents[0]] || baseScene.location : baseScene.location),
    animations,
    stations,
    paths,
  }
}

const resolveTimelineSceneConfig = (timelineKey, allConfigs = {}, behaviorDefaults = {}) => {
  const spec = TRADING_AGENT_TIMELINE_SCENE_BY_KEY[timelineKey] || TIMELINE_SCENE_SPECS[0]
  const phaseBase = resolveSceneConfig(spec.phaseKey, allConfigs?.[spec.phaseKey] || {}, behaviorDefaults)
  const rawTimelineOverride = allConfigs?.[spec.key] || {}
  const timelineOverride = normalizeSceneConfig(rawTimelineOverride, TRADING_AGENT_NAMES)
  const explicitStationOverrides = normalizeSceneAgents(rawTimelineOverride?.__station_overrides, TRADING_AGENT_NAMES)
  const hasExplicitAgentList = Array.isArray(rawTimelineOverride?.agents)
  const defaultTimelineAgents = spec.agentId
    ? normalizeSceneAgents([normalizeTradingAgentName(spec.agentId) || spec.agentId], TRADING_AGENT_NAMES)
    : normalizeSceneAgents(phaseBase.agents, TRADING_AGENT_NAMES)
  const agents = hasExplicitAgentList
    ? normalizeSceneAgents(timelineOverride.agents, TRADING_AGENT_NAMES)
    : defaultTimelineAgents
  const animations = {}
  const stations = {}
  const paths = {}

  agents.forEach((agent) => {
    const behavior = behaviorDefaults?.[agent] || {}
    animations[agent] =
      timelineOverride.animations?.[agent] ||
      timelineOverride.animations?.default ||
      phaseBase.animations?.[agent] ||
      phaseBase.animations?.default ||
      behavior.default_animation ||
      AnimState.IDLE
    const inheritedStation =
      timelineOverride.location ||
      timelineOverride.stations?.default ||
      phaseBase.stations?.default ||
      phaseBase.location ||
      behavior.default_station ||
      LOCATIONS.DESK
    stations[agent] = explicitStationOverrides.includes(agent)
      ? (
          timelineOverride.stations?.[agent] ||
          inheritedStation
        )
      : inheritedStation
    paths[agent] =
      timelineOverride.paths?.[agent] ||
      timelineOverride.paths?.default ||
      phaseBase.paths?.[agent] ||
      phaseBase.paths?.default ||
      behavior.default_path ||
      'direct'
  })

  return {
    key: spec.key,
    phase: String(spec.index).padStart(2, '0'),
    name: spec.name,
    label: spec.label,
    phaseKey: spec.phaseKey,
    isTimelineScene: true,
    agents,
    location: timelineOverride.location || phaseBase.location,
    animations,
    stations,
    paths,
    __station_overrides: explicitStationOverrides,
  }
}

const buildEditableTimelineScene = (scene = {}) => ({
  location: scene.location || LOCATIONS.DESK,
  agents: normalizeSceneAgents(scene.agents, TRADING_AGENT_NAMES),
  animations: { ...(scene.animations || {}) },
  stations: { ...(scene.stations || {}) },
  paths: { ...(scene.paths || {}) },
  __station_overrides: normalizeSceneAgents(scene.__station_overrides, TRADING_AGENT_NAMES),
})

export function PipelineScenesPanel({ connected, onReconnect }) {
  const [selectedTimelineScene, setSelectedTimelineScene] = useState(TIMELINE_SCENE_SPECS[0].key)
  const [agentBehaviorDefaults, setAgentBehaviorDefaults] = useState({})
  const [sceneConfigs, setSceneConfigs] = useState(() => (
    [...Object.keys(STEP_SCENES), ...TIMELINE_SCENE_SPECS.map((scene) => scene.key)].reduce((configs, key) => {
      configs[key] = {}
      return configs
    }, {})
  ))
  const [testResult, setTestResult] = useState(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [testProgress, setTestProgress] = useState([])

  const updateTestProgress = (step, status, detail = '') => {
    setTestProgress((prev) => {
      const next = prev.filter((item) => item.step !== step)
      next.push({ step, status, detail })
      return next
    })
  }

  const readErrorResponse = async (response) => {
    try {
      const body = await response.text()
      if (body) {
        return `${response.status} ${response.statusText} :: ${body.slice(0, 280)}`
      }
    } catch (_err) {
      // ignore body parse errors
    }
    return `${response.status} ${response.statusText}`
  }

  // Load saved configs on mount
  useEffect(() => {
    const loadConfigs = async () => {
      try {
        // Fetch unified agents from DB
        const agentsRes = await fetch(`${API_BASE}/trading-floor/agents/canvas-config`)
        if (agentsRes.ok) {
          const agentsData = await agentsRes.json()
          if (agentsData.short_names) {
            const canonicalAgents = normalizeSceneAgents(agentsData.short_names, TRADING_AGENT_NAMES)
            setAllAgents(canonicalAgents)
          }
        }

        const personalityRes = await fetch(`${API_BASE}/trading-floor/agents/personalities`)
        if (personalityRes.ok) {
          const personalityData = await personalityRes.json()
          setAgentBehaviorDefaults(
            normalizeBehaviorDefaults(personalityData.behavior_defaults || personalityData.agents || {})
          )
        }

        const response = await fetch(`${API_BASE}/api/admin/pipeline_scenes`)
        if (response.ok) {
          const savedData = await response.json()
          if (Object.keys(savedData).length > 0) {
            setSceneConfigs(prev => {
              const newConfigs = { ...prev }
              for (const [sceneKey, config] of Object.entries(savedData)) {
                if (isBrokenTimelineOverride(sceneKey, config)) continue
                newConfigs[sceneKey] = normalizeSceneConfig(config, TRADING_AGENT_NAMES)
              }
              return newConfigs
            })
          }
        }
      } catch (e) {
        console.error('Failed to load saved scene configs:', e)
      }
    }
    loadConfigs()
    // History is now managed by TradingFloorContext/App polling
  }, [])

  // Save single phase config
  const saveCurrentScene = async (phaseKey, config) => {
    setIsSaving(true)
    try {
      const configToSave = isTimelineSceneKey(phaseKey)
        ? buildTimelineSceneSaveConfig(config)
        : {
          ...normalizeSceneConfig(config, TRADING_AGENT_NAMES),
          __explicit: true,
        }
      const response = await fetch(`${API_BASE}/api/admin/pipeline_scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [phaseKey]: configToSave })
      })
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status} ${response.statusText}`)
      }
      const payload = await response.json().catch(() => ({}))
      const persistedConfig = normalizeSceneConfig(
        payload?.saved?.[phaseKey] || configToSave,
        TRADING_AGENT_NAMES
      )
      setSceneConfigs(prev => ({
        ...prev,
        [phaseKey]: persistedConfig,
      }))
      return persistedConfig
    } catch (e) {
      console.error('Failed to save scene config:', e)
      throw e
    } finally {
      setIsSaving(false)
    }
  }

  // Get current scene config
  const activeConfigKey = selectedTimelineScene
  const currentScene = resolveTimelineSceneConfig(selectedTimelineScene, sceneConfigs, agentBehaviorDefaults)
  const activeDispatchPhase = TRADING_AGENT_TIMELINE_SCENE_BY_KEY[selectedTimelineScene]?.phaseKey || 'STEP_1_ANALYSTS'

  const updateCurrentTimelineScene = (updater) => {
    setSceneConfigs((prev) => {
      const resolved = resolveTimelineSceneConfig(activeConfigKey, prev, agentBehaviorDefaults)
      const editable = buildEditableTimelineScene(resolved)
      updater(editable)
      return {
        ...prev,
        [activeConfigKey]: normalizeSceneConfig({
          ...editable,
          __station_overrides: editable.__station_overrides,
          __explicit: true,
          __allow_empty_agents: Array.isArray(editable.agents) && editable.agents.length === 0,
        }, TRADING_AGENT_NAMES),
      }
    })
  }

  // Handle location change
  const handleLocationChange = (location) => {
    updateCurrentTimelineScene((scene) => {
      scene.location = location
      scene.agents.forEach((agent) => {
        scene.stations[agent] = location
      })
      scene.__station_overrides = []
      if (scene.agents.length > 0) scene.__allow_empty_agents = false
    })
  }

  const handleAgentToggle = (agentName) => {
    const canonical = normalizeTradingAgentName(agentName) || agentName
    updateCurrentTimelineScene((scene) => {
      const selected = new Set(scene.agents)
      const explicitOverrides = new Set(scene.__station_overrides || [])
      if (selected.has(canonical)) {
        selected.delete(canonical)
        delete scene.animations[canonical]
        delete scene.stations[canonical]
        delete scene.paths[canonical]
        explicitOverrides.delete(canonical)
      } else {
        selected.add(canonical)
        scene.animations[canonical] = scene.animations[canonical] || AnimState.IDLE
        scene.stations[canonical] = scene.location || LOCATIONS.DESK
        scene.paths[canonical] = scene.paths[canonical] || 'direct'
        explicitOverrides.delete(canonical)
      }
      scene.agents = TRADING_AGENT_NAMES.filter((name) => selected.has(name))
      scene.__station_overrides = TRADING_AGENT_NAMES.filter((name) => explicitOverrides.has(name))
      scene.__allow_empty_agents = scene.agents.length === 0
    })
  }

  const handleSelectAllAgents = () => {
    updateCurrentTimelineScene((scene) => {
      scene.agents = [...TRADING_AGENT_NAMES]
      scene.agents.forEach((agent) => {
        scene.animations[agent] = scene.animations[agent] || AnimState.IDLE
        scene.stations[agent] = scene.location || LOCATIONS.DESK
        scene.paths[agent] = scene.paths[agent] || 'direct'
      })
      scene.__station_overrides = []
      scene.__allow_empty_agents = false
    })
  }

  const handleClearAgents = () => {
    updateCurrentTimelineScene((scene) => {
      scene.agents = []
      scene.animations = {}
      scene.stations = {}
      scene.paths = {}
      scene.__station_overrides = []
      scene.__allow_empty_agents = true
    })
  }

  const handleResetSceneDefaults = () => {
    setSceneConfigs((prev) => ({
      ...prev,
      [activeConfigKey]: {},
    }))
  }

  // Handle animation change for agent
  const handleAnimationChange = (agent, animation) => {
    const canonical = normalizeTradingAgentName(agent) || agent
    updateCurrentTimelineScene((scene) => {
      scene.animations[canonical] = animation
      if (!scene.agents.includes(canonical)) {
        scene.agents = [...scene.agents, canonical]
      }
      scene.__allow_empty_agents = false
    })
  }

  const handleStationChange = (agent, station) => {
    const canonical = normalizeTradingAgentName(agent) || agent
    updateCurrentTimelineScene((scene) => {
      scene.stations[canonical] = station
      if (!scene.agents.includes(canonical)) {
        scene.agents = [...scene.agents, canonical]
      }
      scene.__station_overrides = normalizeSceneAgents(
        [...(scene.__station_overrides || []), canonical],
        TRADING_AGENT_NAMES
      )
      scene.__allow_empty_agents = false
    })
  }

  const handlePathChange = (agent, path) => {
    const canonical = normalizeTradingAgentName(agent) || agent
    updateCurrentTimelineScene((scene) => {
      scene.paths[canonical] = path
      if (!scene.agents.includes(canonical)) {
        scene.agents = [...scene.agents, canonical]
      }
      scene.__allow_empty_agents = false
    })
  }

  const handleSaveScene = async () => {
    setTestProgress([])
    setTestResult(null)
    try {
      const savedScene = await saveCurrentScene(activeConfigKey, currentScene)
      setTestResult({
        success: true,
        message: `Scene "${currentScene.name}" saved (${savedScene.agents?.length || 0} agents).`,
      })
    } catch (e) {
      setTestResult({
        success: false,
        message: `Save failed: ${e.message}`,
      })
    }
  }

  // Test/trigger a scene manually
  const handleTestScene = async () => {
    setIsTesting(true)
    setTestProgress([])
    setTestResult(null)
    
    try {
      updateTestProgress('save', 'running', 'Saving scene config...')
      const savedScene = await saveCurrentScene(activeConfigKey, currentScene)
      updateTestProgress('save', 'ok', 'Scene config saved')
      const scene = resolveTimelineSceneConfig(
        activeConfigKey,
        { ...sceneConfigs, [activeConfigKey]: savedScene },
        agentBehaviorDefaults
      )
      const agents = normalizeSceneAgents(savedScene.agents, TRADING_AGENT_NAMES)
      let playbackStations = scene.stations
      let playbackDirectTargets = {}
      let stationWarnings = []

      updateTestProgress('map', 'running', 'Loading map/station validation...')
      const mapRes = await fetch(`${API_BASE}/api/admin/map`)
      if (mapRes.ok) {
        const mapData = await mapRes.json()
        if (Array.isArray(mapData) && mapData.length > 0) {
          const resolvedStations = resolveSceneStationsForMap({ ...scene, agents }, mapData)
          playbackStations = resolvedStations.stations
          playbackDirectTargets = resolvedStations.directTargets
          stationWarnings = resolvedStations.warnings
          updateTestProgress('map', 'ok', 'Station map validated')
        } else {
          updateTestProgress('map', 'warn', 'Map payload empty; using configured stations')
        }
      } else {
        updateTestProgress('map', 'warn', `Map endpoint unavailable (${mapRes.status})`)
      }

      const playbackScene = {
        ...scene,
        agents,
        stations: playbackStations,
      }
      const movementPlan = buildTimelineMovementPlan(playbackScene)
      if (!movementPlan.length) {
        throw new Error('No active agents selected for movement. Select at least one agent before testing.')
      }
      
      const commandPayload = {
        type: 'PLAY_STEP_SCENE',
        movementOnly: true,
        phase: activeDispatchPhase,
        agents: agents,
        location: scene.location,
        animations: scene.animations,
        stations: playbackStations,
        agentStations: playbackStations,
        agentAnimations: scene.animations,
        agentPaths: scene.paths,
        directTargets: playbackDirectTargets,
        movementPlan,
        headline: `TEST: ${currentScene.label}`,
        ticker: 'TEST TKR',
        timeline_scene_key: selectedTimelineScene,
      }

      updateTestProgress('dispatch_local', 'running', 'Dispatching local scene event...')
      window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: commandPayload }))
      updateTestProgress('dispatch_local', 'ok', 'Local scene event dispatched')
      
      // 2. Dispatch movement-only scene command to websocket clients
      updateTestProgress('dispatch_ws', 'running', 'Broadcasting to websocket clients...')
      const response = await fetch(`${API_BASE}/api/admin/scene_command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commandPayload)
      })
      
      if (!response.ok) {
        const err = await readErrorResponse(response)
        throw new Error(`Failed to broadcast scene command: ${err}`)
      }
      updateTestProgress('dispatch_ws', 'ok', 'Broadcast accepted by backend')

      setTestResult({
        success: true,
        message: stationWarnings.length
          ? `Scene "${scene.name}" triggered with station fallbacks.`
          : `Scene "${scene.name}" triggered and saved!`,
        warnings: stationWarnings,
      })
    } catch (e) {
      console.error('Failed to test scene:', e)
      updateTestProgress('failed', 'error', e.message)
      setTestResult({
        success: false,
        message: `Failed: ${e.message}`,
      })
    } finally {
      setIsTesting(false)
    }
  }

  const timelinePane = (
    <div className="space-y-2">
      <div className="pipeline-scenes-title">SELECT TRADING AGENTS TIMELINE SCENE (13)</div>
      <div className="pipeline-scenes-phase-grid">
        {TIMELINE_SCENE_SPECS.map((scene) => (
          <button
            type="button"
            key={scene.key}
            className={`pipeline-scenes-phase-btn ${selectedTimelineScene === scene.key ? 'active' : ''}`}
            onClick={() => setSelectedTimelineScene(scene.key)}
          >
            <span className="pipeline-scenes-phase-number">{String(scene.index).padStart(2, '0')}</span>
            <span className="pipeline-scenes-phase-name-wrap">
              <span className="pipeline-scenes-phase-name">{scene.name}</span>
              <span className="pipeline-scenes-phase-subtitle">{scene.label}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="pipeline-scenes-scene-meta">
        <div className="pipeline-scenes-meta-card">
          <span>Selected Scene</span>
          <strong>{currentScene.name}</strong>
        </div>
        <div className="pipeline-scenes-meta-card">
          <span>Phase</span>
          <strong>{currentScene.phase}</strong>
        </div>
        <div className="pipeline-scenes-meta-card">
          <span>Agents Active</span>
          <strong>{currentScene.agents.length}/{TRADING_AGENT_NAMES.length}</strong>
        </div>
        <div className="pipeline-scenes-meta-card">
          <span>Location</span>
          <strong>{currentScene.location}</strong>
        </div>
      </div>
    </div>
  )

  const configPane = (
    <div className="space-y-2">
      <div className="pipeline-scenes-section">
        <ShowrunnerPanel connected={connected} onReconnect={onReconnect} />
      </div>

      <div className="pipeline-scenes-section">
        <div className="pipeline-scenes-title">SCENE CONFIG</div>

        <div className="pipeline-scenes-config-row">
          <label>Location:</label>
          <select
            value={currentScene.location}
            onChange={(e) => handleLocationChange(e.target.value)}
            className="pipeline-scenes-select"
          >
            {LOCATION_OPTIONS.map((opt, idx) => (
              <option key={`${opt.value}-${idx}`} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="pipeline-scenes-config-row">
          <label>Agents:</label>
          <div className="pipeline-scenes-agent-actions">
            <button type="button" className="pipeline-scenes-mini-btn" onClick={handleSelectAllAgents}>SELECT ALL</button>
            <button type="button" className="pipeline-scenes-mini-btn" onClick={handleClearAgents}>CLEAR</button>
            <button type="button" className="pipeline-scenes-mini-btn" onClick={handleResetSceneDefaults}>RESET DEFAULTS</button>
          </div>
          <div className="pipeline-scenes-helper-row">
            Pick who participates in this scene. Unselected agents will not be dispatched.
          </div>
          <div className="pipeline-scenes-agent-checkboxes">
            {TRADING_AGENT_NAMES.map((agent) => (
              <label
                key={agent}
                className={`pipeline-scenes-agent-checkbox ${currentScene.agents.includes(agent) ? 'active' : 'inactive'}`}
              >
                <input
                  type="checkbox"
                  checked={currentScene.agents.includes(agent)}
                  onChange={() => handleAgentToggle(agent)}
                />
                <span>{agent}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="pipeline-scenes-section">
        <div className="pipeline-scenes-title">ANIMATIONS & STATIONS</div>
        <div className="pipeline-scenes-helper-row">
          Set per-agent animation, destination station, and movement path for this timeline step.
        </div>
        <div className="pipeline-scenes-animation-grid">
          <div className="pipeline-scenes-animation-header">
            <span>Agent</span>
            <span>Animation</span>
            <span>Station</span>
            <span>Path</span>
          </div>
          {currentScene.agents.length === 0 && (
            <div className="pipeline-scenes-empty-state">
              No agents selected. Choose at least one agent above to configure animation routing.
            </div>
          )}
          {currentScene.agents.map((agent) => (
            <div key={agent} className="pipeline-scenes-animation-row">
              <span className="pipeline-scenes-agent-name">{agent}</span>
              <select
                value={currentScene.animations?.[agent] || AnimState.IDLE}
                onChange={(e) => handleAnimationChange(agent, e.target.value)}
                className="pipeline-scenes-select pipeline-scenes-animation-select"
              >
                {ANIMATION_OPTIONS.map((opt, idx) => (
                  <option key={`${opt.label}-${idx}`} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
                ))}
              </select>
              <select
                value={currentScene.stations?.[agent] || LOCATIONS.CENTER}
                onChange={(e) => handleStationChange(agent, e.target.value)}
                className="pipeline-scenes-select"
              >
                {LOCATION_OPTIONS.map((opt, idx) => (
                  <option key={`loc-${opt.value}-${idx}`} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select
                value={currentScene.paths?.[agent] || 'direct'}
                onChange={(e) => handlePathChange(agent, e.target.value)}
                className="pipeline-scenes-select"
              >
                {PATH_OPTIONS.map((opt, idx) => (
                  <option key={`path-${opt.value}-${idx}`} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="pipeline-scenes-section">
        <div className="pipeline-scenes-actions-bar">
          <div className="pipeline-scenes-help-text">
            Test flow: save scene, local animation/pathfinding playback, then WebSocket broadcast.
          </div>
          <div className="pipeline-scenes-actions">
            <button
              className="pipeline-scenes-primary-btn"
              onClick={handleSaveScene}
              disabled={isSaving || isTesting}
            >
              {isSaving ? 'SAVING...' : 'SAVE SCENE'}
            </button>
            <button
              className="pipeline-scenes-primary-btn"
              onClick={handleTestScene}
              disabled={isTesting || isSaving}
            >
              {isTesting ? 'RUNNING TEST...' : 'TEST SCENE'}
            </button>
          </div>
        </div>

        {testProgress.length > 0 && (
          <div className="pipeline-scenes-progress">
            {testProgress.map((item) => (
              <div key={item.step} className={`pipeline-scenes-progress-row ${item.status}`}>
                <span className="pipeline-scenes-progress-step">{item.step}</span>
                <span className="pipeline-scenes-progress-detail">{item.detail}</span>
              </div>
            ))}
          </div>
        )}

        {testResult && (
          <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
            <div className="result-message">{testResult.message}</div>
            {Array.isArray(testResult.warnings) && testResult.warnings.length > 0 && (
              <div className="result-warnings">
                {testResult.warnings.map((warning, i) => (
                  <div key={i} className="warning-line">
                    {warning}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="tab-content final-reports-panel pipeline-scenes-panel h-full min-h-0">
      <div className="reports-command-deck reports-command-deck--history pipeline-scenes-deck">
        <div className="reports-command-body">
          <aside className="reports-command-timeline" aria-label="Pipeline scenes timeline">
            <header className="reports-command-section-title">
              <span>TIMELINE</span>
              <span>SELECTED {currentScene.phase}</span>
            </header>
            <div className="pipeline-scenes-scroll">{timelinePane}</div>
          </aside>

          <main className="reports-command-reader" aria-label="Pipeline scene editor">
            <header className="reports-command-section-title reports-command-section-title--reader">
              <span>SCENE EDITOR</span>
              <span>{currentScene.agents.length} AGENTS ACTIVE</span>
            </header>
            <div className="pipeline-scenes-scroll">{configPane}</div>
          </main>
        </div>
      </div>
    </div>
  )
}

export default PipelineScenesPanel
