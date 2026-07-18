// Showrunner.js - The Director class for scene orchestration
// Lives INSIDE Phaser, listens for CustomEvents from React
// Completely decouples React renders from Phaser's update loop

import { GATHER_SPOTS, resolveAgentName, STATION_TILE_MAP, TILE_TYPES } from '../../../utils/constants'
import { getGridPos, findNearestWalkableCoord, findPathToCoord, isWalkable } from './pathfinding'
import { AnimStateType } from './animation'
import { MovePriority } from './MovementManager'

const isShowrunnerDebug = () => (
  typeof window !== 'undefined' &&
  window.TRADING_FLOOR_DEBUG === true
)

const showrunnerLog = (...args) => {
  if (isShowrunnerDebug()) {
    console.log(...args)
  }
}

const PATH_STYLE_CODES = {
  0: 'direct',
  1: 'detour',
  2: 'loop',
  3: 'idle'
}

const DETOUR_STATIONS = ['cooler', 'table', 'tv', 'newsstand', 'window', 'desk']
const STATION_ALIASES = {
  desks: 'desk',
  'water cooler': 'cooler',
  water_cooler: 'cooler',
  'center table': 'table',
  center_table: 'table',
  'center stage': 'center',
  center_stage: 'center',
}

const WALKABLE_TILES = new Set([TILE_TYPES.FLOOR, TILE_TYPES.RUG, TILE_TYPES.MONEY, TILE_TYPES.DOOR])
const MANUAL_RALLY_RESUME_COMMANDS = new Set([
  'GOSSIP_SCENE',
  'EMERGENCY_SELL',
  'CONSENSUS_SCENE',
  'MOVE_AGENT',
  'MOVE_AGENTS',
  'PLAY_EMOTE',
  'RETURN_TO_DESKS',
  'STATION_MOVE',
  'PLAY_ERROR',
  'QUEUE_POP_LOW',
  'QUEUE_POP_DEEP',
  'MOVE_AGENT_TO',
  'TIER_1_ANALYSIS',
  'TIER_2_ANALYSIS',
  'TIER_3_ANALYSIS',
  'TIER_4_GATHERING',
  'TIER_5_GATHERING',
  'TIER_3_GATHERING',
  'TIER_3_COMPLETE',
  'TIER_COMPLETE',
  'PLAY_STEP_SCENE',
  'NEWS_SCRIPT',
  'TA_SCENE',
])

function normalizeStationKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return 'desk'
  return STATION_ALIASES[raw] || raw
}

function hasStationTiles(roomMap, station) {
  const tileType = STATION_TILE_MAP[normalizeStationKey(station)]
  if (tileType == null) return true
  if (!Array.isArray(roomMap)) return false
  for (let r = 0; r < roomMap.length; r++) {
    const row = roomMap[r]
    if (!Array.isArray(row)) continue
    for (let c = 0; c < row.length; c++) {
      if (Number(row[c]) === tileType) return true
    }
  }
  return false
}

function tileKey(tile) {
  return `${tile.c},${tile.r}`
}

function findStationTiles(roomMap, station) {
  const tileType = STATION_TILE_MAP[normalizeStationKey(station)]
  if (tileType == null || !Array.isArray(roomMap)) return []
  const tiles = []
  for (let r = 0; r < roomMap.length; r++) {
    const row = roomMap[r]
    if (!Array.isArray(row)) continue
    for (let c = 0; c < row.length; c++) {
      if (Number(row[c]) === tileType) tiles.push({ c, r })
    }
  }
  return tiles
}

function buildStationTargetPool(roomMap, station, requiredCount = 0) {
  const stationTiles = findStationTiles(roomMap, station)
  if (!stationTiles.length) return []

  const targets = []
  const seen = new Set()
  const maxRadius = Math.max(4, Math.min(8, Math.ceil(Math.sqrt(Math.max(requiredCount, 1))) + 4))

  for (let radius = 1; radius <= maxRadius; radius++) {
    stationTiles.forEach((stationTile) => {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue
          const tile = { c: stationTile.c + dc, r: stationTile.r + dr }
          const key = tileKey(tile)
          if (seen.has(key)) continue
          if (!isWalkable(tile.c, tile.r, null, null, roomMap)) continue
          seen.add(key)
          targets.push(tile)
        }
      }
    })
    if (targets.length >= requiredCount) break
  }

  return targets
}

function findNearestWalkableTile(roomMap, fromPos = null) {
  const candidates = []
  if (!Array.isArray(roomMap)) return null
  for (let r = 0; r < roomMap.length; r++) {
    const row = roomMap[r]
    if (!Array.isArray(row)) continue
    for (let c = 0; c < row.length; c++) {
      if (WALKABLE_TILES.has(row[c])) candidates.push({ c, r })
    }
  }
  if (!candidates.length) return null
  if (!fromPos) return candidates[0]
  return candidates.reduce((best, tile) => {
    const dist = Math.abs(tile.c - fromPos.c) + Math.abs(tile.r - fromPos.r)
    const bestDist = Math.abs(best.c - fromPos.c) + Math.abs(best.r - fromPos.r)
    return dist < bestDist ? tile : best
  }, candidates[0])
}

// Command types that React can dispatch
export const SceneCommandType = {
  GOSSIP_SCENE: 'GOSSIP_SCENE',
  EMERGENCY_SELL: 'EMERGENCY_SELL',
  CONSENSUS_SCENE: 'CONSENSUS_SCENE',
  MOVE_AGENT: 'MOVE_AGENT',
  MOVE_AGENTS: 'MOVE_AGENTS',
  PLAY_EMOTE: 'PLAY_EMOTE',
  RETURN_TO_DESKS: 'RETURN_TO_DESKS',
  STATION_MOVE: 'STATION_MOVE',
  PLAY_ERROR: 'PLAY_ERROR',
  // God Mode additions
  QUEUE_POP_LOW: 'QUEUE_POP_LOW',
  QUEUE_POP_DEEP: 'QUEUE_POP_DEEP',

  MOVE_AGENT_TO: 'MOVE_AGENT_TO',
  // Tier-based gathering commands (5-tier system)
  TIER_1_ANALYSIS: 'TIER_1_ANALYSIS',  // FREE - quick market pass
  TIER_2_ANALYSIS: 'TIER_2_ANALYSIS',  // BRONZE - 3 agents
  TIER_3_ANALYSIS: 'TIER_3_ANALYSIS',  // SILVER - 5 agents
  TIER_4_GATHERING: 'TIER_4_GATHERING', // GOLD - 8 agents
  TIER_5_GATHERING: 'TIER_5_GATHERING', // WHALE - All agents
  TIER_3_GATHERING: 'TIER_3_GATHERING', // Legacy alias
  TIER_3_COMPLETE: 'TIER_3_COMPLETE',
  TIER_COMPLETE: 'TIER_COMPLETE',
  // Pipeline step scene commands
  PLAY_STEP_SCENE: 'PLAY_STEP_SCENE',
  STEP_SCENE_COMPLETE: 'STEP_SCENE_COMPLETE',
  // News script broadcast
  NEWS_SCRIPT: 'NEWS_SCRIPT',
  // TradingAgents phase scenes
  TA_SCENE: 'TA_SCENE',
}

export class Showrunner {
  constructor(scene) {
    this.scene = scene
    this.reservedTiles = new Map() // "c,r" -> agentId
    this.eventListeners = []
    this.manualRally = {
      active: false,
      anchorTile: null,
      assignedTiles: new Map(),
      startedAt: 0,
      source: null,
    }

    this.setupEventListeners()

    // Bind cleanup to scene shutdown/destroy to fix hot reload zombie listeners
    if (this.scene && this.scene.events) {
      this.scene.events.once('shutdown', this.destroy, this)
      this.scene.events.once('destroy', this.destroy, this)
    }

    showrunnerLog('[Showrunner] Initialized and listening for SCENE_COMMAND events')
  }

  /**
   * Setup CustomEvent listeners - React dispatches, Showrunner listens
   */
  setupEventListeners() {
    const commandHandler = (e) => {
      showrunnerLog('[Showrunner] Received SCENE_COMMAND event:', e.detail)
      this.handleCommand(e.detail)
    }

    window.addEventListener('SCENE_COMMAND', commandHandler)

    // Store for cleanup
    this.eventListeners.push({ event: 'SCENE_COMMAND', handler: commandHandler })
  }

  /**
   * Main command router - dispatches to appropriate scene method
   */
  handleCommand(cmd) {
    if (!cmd || !cmd.type) {
      console.warn('[Showrunner] Invalid command received:', cmd)
      return
    }

    if (this.shouldResumeAutomationForCommand(cmd)) {
      this.clearManualRally(`automation:${cmd.type}`)
    }

    showrunnerLog('[Showrunner] Handling command:', cmd.type, cmd)

    switch (cmd.type) {
      case SceneCommandType.GOSSIP_SCENE:
        this.playGossipScene(cmd.actors, cmd.dialogue, cmd.location)
        break
      case SceneCommandType.EMERGENCY_SELL:
        this.playEmergencySellScene(cmd.ticker)
        break
      case SceneCommandType.CONSENSUS_SCENE:
        this.playConsensusScene(cmd.agents, cmd.topic)
        break
      case SceneCommandType.MOVE_AGENT:
        this.commandMoveAgent(cmd.agentId, cmd.target)
        break
      case SceneCommandType.MOVE_AGENTS:
        this.commandMoveAgents(cmd.agentIds, cmd.location)
        break
      case SceneCommandType.PLAY_EMOTE:
        this.commandPlayEmote(cmd.agentIds || [cmd.agentId], cmd.emote)
        break
      case SceneCommandType.RETURN_TO_DESKS:
        this.commandReturnToDesks(cmd.agentIds || [cmd.agentId])
        break
      case SceneCommandType.STATION_MOVE:
        this.commandStationMove(cmd.agentIds || [cmd.agentId], cmd.station)
        break
      case SceneCommandType.PLAY_ERROR:
        this.commandPlayError(cmd.agentId, cmd.emote)
        break
      // God Mode commands
      case SceneCommandType.QUEUE_POP_LOW:
        this.playQueuePopLow(cmd.ticker)
        break
      case SceneCommandType.QUEUE_POP_DEEP:
        this.playQueuePopDeep(cmd.ticker)
        break
      // News script broadcast
      case SceneCommandType.NEWS_SCRIPT:
        this.playNewsScript(cmd)
        break
      // TradingAgents phase scenes
      case SceneCommandType.TA_SCENE:
        this.playTAScene(cmd)
        break

      case SceneCommandType.MOVE_AGENT_TO:
        this.moveAgentTo(cmd.agentId, cmd.x, cmd.y)
        break
      case SceneCommandType.TIER_3_GATHERING:
        this.playTier3WhaleGathering(cmd.ticker, cmd.donor, cmd.amount)
        break
      case SceneCommandType.TIER_3_COMPLETE:
        this.completeTier3Gathering(cmd.action, cmd.confidence)
        break
      // New 5-tier system commands
      case SceneCommandType.TIER_1_ANALYSIS:
        this.playTier1Analysis(cmd.ticker)
        break
      case SceneCommandType.TIER_2_ANALYSIS:
        this.playTier2Analysis(cmd.ticker, cmd.agents)
        break
      case SceneCommandType.TIER_3_ANALYSIS:
        this.playTier3Analysis(cmd.ticker, cmd.agents)
        break
      case SceneCommandType.TIER_4_GATHERING:
        this.playTier4Gathering(cmd.ticker, cmd.donor, cmd.amount)
        break
      case SceneCommandType.TIER_5_GATHERING:
        this.playTier5WhaleGathering(cmd.ticker, cmd.donor, cmd.amount)
        break
      case SceneCommandType.TIER_COMPLETE:
        this.completeTierGathering(cmd.tier, cmd.action, cmd.confidence)
        break
      // Pipeline step scene commands
      case SceneCommandType.PLAY_STEP_SCENE:
        this.playStepScene(
          cmd.phase,
          cmd.agents,
          cmd.location,
          cmd.animations,
          cmd.agentStations,
          cmd.agentAnimations,
          cmd.agentPaths,
          cmd.highlight,
          cmd.highlightAgents,
          cmd.directTargets
        )
        break
      case SceneCommandType.STEP_SCENE_COMPLETE:
        this.completeStepScene(cmd.phase)
        break
      default:
        console.warn('[Showrunner] Unknown command type:', cmd.type)
    }
    return null
  }

  shouldResumeAutomationForCommand(cmd) {
    return this.isManualRallyActive() && MANUAL_RALLY_RESUME_COMMANDS.has(cmd?.type)
  }

  isManualRallyActive() {
    return Boolean(this.manualRally?.active)
  }

  clearManualRally(reason = 'manual-clear') {
    if (!this.isManualRallyActive()) return
    showrunnerLog('[Showrunner] Clearing manual rally:', reason)
    for (const [agentId, tile] of this.manualRally.assignedTiles.entries()) {
      const agent = this.scene?.agents?.[agentId]
      if (agent && this.scene?.tweens) {
        this.scene.tweens.killTweensOf(agent)
      }
      if (tile) {
        this.releaseTile(tile.c, tile.r)
      }
      if (this.scene?.animController && agentId) {
        this.scene.animController.setBaseState(agentId, AnimStateType.IDLE)
        this.scene.animController.reset(agentId, AnimStateType.IDLE)
      } else {
        this.scene?.playAnimation?.(agentId, AnimStateType.IDLE)
      }
    }
    this.manualRally = {
      active: false,
      anchorTile: null,
      assignedTiles: new Map(),
      startedAt: 0,
      source: reason,
    }
  }

  rallyAllAgentsToPointer(x, y) {
    const roomMap = this.scene?.getRoomMap?.() || this.scene?.roomMap || []
    if (!Array.isArray(roomMap) || roomMap.length === 0) return false

    const requestedTile = getGridPos(x, y)
    const clampedTile = {
      c: Math.max(0, Math.min((roomMap[0]?.length || 1) - 1, requestedTile.c)),
      r: Math.max(0, Math.min(roomMap.length - 1, requestedTile.r)),
    }
    const agentIds = Object.keys(this.scene?.agents || {})
    const clickedType = Number(roomMap?.[clampedTile.r]?.[clampedTile.c])
    const clickedTableCluster = clickedType === TILE_TYPES.TABLE
      ? (this.getTableClusterForTile(clampedTile) || this.getPrimaryTableCluster())
      : null

    if (clickedTableCluster?.tiles?.length) {
      const tableAssignments = this.allocateManualRallyTableTargets(clickedTableCluster, agentIds)
      if (tableAssignments.length > 0) {
        const clusterCenterTile = {
          c: Math.round(clickedTableCluster.center?.c ?? clampedTile.c),
          r: Math.round(clickedTableCluster.center?.r ?? clampedTile.r),
        }
        const tableAnchor = findNearestWalkableCoord(roomMap, clusterCenterTile.c, clusterCenterTile.r) || clusterCenterTile
        this.clearManualRally('retarget')

        const assignedTiles = new Map(tableAssignments.map(({ agentId, target }) => [resolveAgentName(agentId), target]))
        this.manualRally = {
          active: true,
          anchorTile: tableAnchor,
          assignedTiles,
          startedAt: Date.now(),
          source: 'canvas-click:table-seats',
        }

        tableAssignments.forEach(({ agentId, target }) => {
          this.commandMoveAgentToTile(agentId, target, {
            priority: MovePriority.USER,
            source: 'manual-rally:table',
            arrivalAnimation: AnimStateType.TALK,
            faceTarget: clickedTableCluster.center || tableAnchor,
          })
        })

        return true
      }
    }

    const anchorTile = findNearestWalkableCoord(roomMap, clampedTile.c, clampedTile.r)
    if (!anchorTile) {
      console.warn('[Showrunner] Manual rally failed: no walkable target near pointer', clampedTile)
      return false
    }

    const assignments = this.allocateManualRallyTargets(anchorTile, agentIds, roomMap)
    if (assignments.length === 0) {
      console.warn('[Showrunner] Manual rally failed: no reachable targets for agents')
      return false
    }

    this.clearManualRally('retarget')

    const assignedTiles = new Map(assignments.map(({ agentId, target }) => [resolveAgentName(agentId), target]))
    this.manualRally = {
      active: true,
      anchorTile,
      assignedTiles,
      startedAt: Date.now(),
      source: 'canvas-click',
    }

    assignments.forEach(({ agentId, target }) => {
      this.commandMoveAgentToTile(agentId, target, {
        priority: MovePriority.USER,
        source: 'manual-rally',
        arrivalAnimation: AnimStateType.IDLE,
        faceTarget: anchorTile,
      })
    })

    return true
  }

  allocateManualRallyTargets(anchorTile, agentIds, roomMap) {
    const ids = (Array.isArray(agentIds) ? agentIds : [agentIds])
      .map((id) => resolveAgentName(id))
      .filter((agentId, index, arr) => agentId && this.scene?.agents?.[agentId] && arr.indexOf(agentId) === index)

    if (!ids.length) return []

    const maxRadius = Math.max(roomMap.length, roomMap[0]?.length || 0)
    const candidates = []
    const seen = new Set()

    for (let radius = 0; radius <= maxRadius && candidates.length < ids.length; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue
          const tile = { c: anchorTile.c + dc, r: anchorTile.r + dr }
          const key = tileKey(tile)
          if (seen.has(key)) continue
          seen.add(key)
          if (!isWalkable(tile.c, tile.r, null, null, roomMap)) continue
          candidates.push(tile)
          if (candidates.length >= ids.length) break
        }
        if (candidates.length >= ids.length) break
      }
    }

    if (!candidates.length) {
      candidates.push(anchorTile)
    }

    const availableTargets = candidates.slice()
    return ids.map((agentId) => {
      const agent = this.scene.agents[agentId]
      const pos = getGridPos(agent.x, agent.y)
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY

      availableTargets.forEach((tile, index) => {
        const distance = Math.abs(tile.c - pos.c) + Math.abs(tile.r - pos.r)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      })

      const [target] = availableTargets.splice(bestIndex, 1)
      return { agentId, target: target || anchorTile }
    })
  }

  allocateManualRallyTableTargets(cluster, agentIds) {
    const ids = (Array.isArray(agentIds) ? agentIds : [agentIds])
      .map((id) => resolveAgentName(id))
      .filter((agentId, index, arr) => agentId && this.scene?.agents?.[agentId] && arr.indexOf(agentId) === index)
    if (!ids.length) return []

    const { seats } = this.discoverTableSeats(cluster)
    if (!Array.isArray(seats) || seats.length === 0) return []

    const occupiedSeatKeys = this.getOccupiedSeatKeys(ids)
    const freeSeats = seats.filter((seat) => !occupiedSeatKeys.has(this.getSeatTileKey(seat)))
    const seatPool = (freeSeats.length > 0 ? freeSeats : seats).slice()
    if (!seatPool.length) return []

    return ids.map((agentId) => {
      const agent = this.scene.agents[agentId]
      const pos = getGridPos(agent.x, agent.y)
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY

      seatPool.forEach((tile, index) => {
        const distance = Math.abs(tile.c - pos.c) + Math.abs(tile.r - pos.r)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      })

      const [target] = seatPool.splice(bestIndex, 1)
      return { agentId, target: target || seats[0] }
    })
  }

  // ============================================
  // SCENE ORCHESTRATION METHODS
  // ============================================

  /**
   * Play a gossip scene - move agents to location, start talking
   */
  playGossipScene(actors, dialogue, location = 'cooler') {
    if (!actors?.length) return

    console.log('[Showrunner] Playing gossip scene with:', actors)

    // Move agents to gathering location
    this.commandMoveAgents(actors, location)
  }

  /**
   * Play news script with agent stations, emotes, and dialogue
   * @param {Object} data - { headline, dialogue, agents, agentStations, agentAnimations }
   */
  playNewsScript(data) {
    if (!data) return
    const { headline, agents, agentStations, agentAnimations } = data
    
    console.log('[Showrunner] Playing news script:', headline, { agents, agentStations, agentAnimations })
    
    // Move agents to their assigned stations
    if (agentStations) {
      Object.entries(agentStations).forEach(([agent, station]) => {
        this.commandStationMove([agent], station)
      })
    }
    
    // Set emotes/animations after movement
    if (agentAnimations) {
      setTimeout(() => {
        Object.entries(agentAnimations).forEach(([agent, emote]) => {
          this.commandPlayEmote([agent], emote)
        })
      }, 2000)
    }
    
    // Dialogue is handled by TradingFloorScene via activeScene context
  }

  /**
   * TradingAgents phase scene - trigger animations and pathfinding for each TA phase
   */
  playTAScene(cmd) {
    if (!cmd) return
    const { phase, location, agents, animations, variantName } = cmd
    
    console.log('[Showrunner] Playing TA scene for phase:', phase, {
      location,
      agents,
      animations,
      variantName
    })
    
    // Check if we have agents in the scene
    if (!this.scene?.agents || Object.keys(this.scene.agents).length === 0) {
      console.warn('[Showrunner] No agents available in scene yet!')
      return
    }
    
    // Build agentStations map - featured agents go to phase location, others stay at desks
    const agentStations = {}
    const featuredAgents = agents || []
    const allAgentNames = Object.keys(this.scene.agents)
    
    console.log('[Showrunner] Available agents:', allAgentNames)
    console.log('[Showrunner] Featured agents from config:', featuredAgents)
    
    // Featured agents go to the phase-specific location
    featuredAgents.forEach(agentName => {
      // Convert short name to full name using AGENT_NAME_MAP
      const fullName = resolveAgentName(agentName)
      
      console.log(`[Showrunner] Mapping ${agentName} -> ${fullName}, exists: ${!!this.scene.agents[fullName]}`)
      
      if (this.scene.agents[fullName]) {
        agentStations[fullName] = location
      } else {
        console.warn(`[Showrunner] Agent not found: ${fullName}`)
      }
    })
    
    console.log('[Showrunner] Final agent stations:', agentStations)
    
    // Move featured agents to their stations
    Object.entries(agentStations).forEach(([agent, station]) => {
      console.log(`[Showrunner] Moving ${agent} to ${station}`)
      this.commandStationMove([agent], station)
    })
    
    // Set animations/emotes after movement
    if (animations) {
      setTimeout(() => {
        Object.entries(animations).forEach(([agentName, emote]) => {
          const fullName = resolveAgentName(agentName)
          
          if (this.scene.agents[fullName]) {
            console.log(`[Showrunner] Playing emote ${emote} for ${fullName}`)
            this.commandPlayEmote([fullName], emote)
          } else {
            console.warn(`[Showrunner] Cannot play emote - agent not found: ${fullName}`)
          }
        })
      }, 2000)
    }
    
    // Dialogue is handled by TradingFloorScene via activeScene context
  }

  /**
   * Emergency sell scene - flash red, all agents to desks
   */
  playEmergencySellScene(ticker) {
    console.log('[Showrunner] EMERGENCY SELL:', ticker)

    // Flash camera red
    this.commandFlashCamera(0xff0000, 500)

    // Move all agents to desks quickly
    const allAgents = Object.keys(this.scene.agents)
    allAgents.forEach(agentId => {
      const agent = this.scene.agents[agentId]
      if (agent?.homePos) {
        const pos = getGridPos(agent.x, agent.y)
        const path = findPathToCoord(
          this.scene.roomMap,
          pos.c, pos.r,
          agent.homePos.c, agent.homePos.r,
          this.reservedTiles,
          agentId
        )
        if (path) {
          this.reserveTile(agent.homePos.c, agent.homePos.r, agentId)
          this.scene.startPathMovement(agent, path, () => {
            this.releaseTile(agent.homePos.c, agent.homePos.r)
            this.scene.resetAgent(agentId)
          })
        }
      }
    })
  }

  /**
   * Consensus scene - agents gather at table
   */
  playConsensusScene(agents, topic) {
    console.log('[Showrunner] Consensus scene:', topic)
    this.commandMoveAgents(agents, 'table')
  }

  /**
   * Queue pop low - small analysis with 3 agents
   */
  playQueuePopLow(ticker) {
    console.log('[Showrunner] Queue Pop Low:', ticker)
    const agents = ['Market Analyst', 'Trader', 'Risk Judge']
    this.commandMoveAgents(agents, 'table')
    this.commandFlashCamera(0x00ff00, 300)
  }

  /**
   * Queue pop deep - full consensus with all agents
   */
  playQueuePopDeep(ticker) {
    console.log('[Showrunner] Queue Pop Deep:', ticker)
    const allAgents = Object.keys(this.scene.agents)
    this.commandMoveAgents(allAgents.slice(0, 6), 'table')
    this.commandFlashCamera(0xffff00, 500)
  }

  // ============================================
  // COMMAND METHODS (dumb execution)
  // ============================================

  /**
   * Move a single agent to a target grid position
   * Uses tile reservation for collision avoidance
   */
  commandMoveAgent(agentId, target, _retryCount = 0) {
    if (_retryCount > 10) {
      console.warn(`[Showrunner] Max retries reached for moving agent ${agentId}. Aborting to prevent infinite loop.`)
      return
    }

    const fullName = resolveAgentName(agentId)
    const agent = this.scene.agents[fullName]
    if (!agent || !target) return

    // Clean up existing movement and reservations before pathfinding
    if (this.scene.tweens) this.scene.tweens.killTweensOf(agent)
    this.clearAgentReservation(fullName)

    const pos = getGridPos(agent.x, agent.y)

    // Find path, avoiding reserved tiles (except our own)
    const path = findPathToCoord(
      this.scene.roomMap,
      pos.c, pos.r,
      target.c, target.r,
      this.reservedTiles,
      fullName
    )

    if (path) {
      // Reserve the destination tile
      this.reserveTile(target.c, target.r, fullName)
      this.scene.startPathMovement(agent, path, () => {
        this.releaseTile(target.c, target.r)
      })
    } else {
      // Path blocked - retry after 500ms
      console.log(`[Showrunner] Path blocked for ${fullName}, retrying in 500ms...`)
      this.scene.time.delayedCall(500, () => {
        this.commandMoveAgent(agentId, target, _retryCount + 1)
      })
    }
  }

  commandMoveAgentToTile(agentId, target, options = {}) {
    const fullName = resolveAgentName(agentId)
    const agent = this.scene?.agents?.[fullName]
    if (!agent || !target) return false

    const priority = options?.priority ?? MovePriority.USER
    const source = options?.source || 'showrunner:tile-move'
    const faceTarget = options?.faceTarget || null
    const arrivalAnimation = options?.arrivalAnimation || AnimStateType.IDLE
    const roomMap = this.scene?.getRoomMap?.() || this.scene?.roomMap || []

    if (this.scene.movementManager?.cancelMovement) {
      this.scene.movementManager.cancelMovement(fullName, `${source}:override`)
    }

    if (this.scene.tweens) this.scene.tweens.killTweensOf(agent)
    agent.setScale(1)
    this.clearAgentReservation(fullName)

    const pos = getGridPos(agent.x, agent.y)
    const pathReservations = priority >= MovePriority.USER ? null : this.reservedTiles
    const path = findPathToCoord(
      roomMap,
      pos.c,
      pos.r,
      target.c,
      target.r,
      pathReservations,
      fullName
    )

    if (!path) {
      console.warn(`[Showrunner] No path for ${fullName} → ${target.c},${target.r} (${source})`)
      return false
    }

    this.reserveTile(target.c, target.r, fullName)

    if (this.scene.animController) {
      this.scene.animController.setBaseState(fullName, AnimStateType.IDLE)
    }

    this.scene.startPathMovement(agent, path, () => {
      this.releaseTile(target.c, target.r)

      if (faceTarget) {
        this.scene.faceTarget(agent, faceTarget)
      }

      if (this.scene.animController) {
        this.scene.animController.setBaseState(fullName, arrivalAnimation)
        this.scene.animController.reset(fullName, arrivalAnimation)
      } else {
        this.scene.playAnimation?.(fullName, arrivalAnimation)
      }
    })

    return true
  }

  /**
   * Move multiple agents to a gathering location
   * Uses tile reservation for collision avoidance
   */
  commandMoveAgents(agentIds, location = 'cooler', options = {}) {
    const normalizedLocation = normalizeStationKey(location)
    const arrivalEmotes = options?.arrivalEmotes || {}
    const preserveArrivalEmote = Boolean(options?.preserveArrivalEmote)
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds]
    const roomMap = this.scene?.getRoomMap?.() || this.scene?.roomMap || []
    const stationTiles = findStationTiles(roomMap, normalizedLocation)
    const stationSpots = buildStationTargetPool(roomMap, normalizedLocation, ids.length)
    const dynamicSpots = this.scene?.getGatherSpots?.(normalizedLocation)
    const fallbackSpots = GATHER_SPOTS[normalizedLocation]
    const spotsRaw =
      Array.isArray(stationSpots) && stationSpots.length > 0
        ? stationSpots
        : Array.isArray(dynamicSpots) && dynamicSpots.length > 0
        ? dynamicSpots
        : fallbackSpots
    const spots = Array.isArray(spotsRaw)
      ? spotsRaw.filter((spot) => spot && Number.isFinite(spot.c) && Number.isFinite(spot.r))
      : []
    if (!ids?.length) return
    if (!Array.isArray(spots) || spots.length === 0) {
      console.warn(`[Showrunner] No gather spots available for location "${normalizedLocation}"`)
      // Fallback to MovementManager station logic when custom gather spots are unavailable.
      ids.forEach((id) => {
        const fullName = resolveAgentName(id)
        const accepted = this.scene?.moveAgentToStation?.(
          fullName,
          normalizedLocation,
          MovePriority.USER,
          'showrunner:no-spots-fallback'
        )
        if (!accepted) {
          this.scene?.moveAgentToStation?.(
            fullName,
            'desk',
            MovePriority.USER,
            'showrunner:no-spots-desk-fallback'
          )
        }
      })
      return
    }

    const allocationDebug = {
      station: normalizedLocation,
      requested: ids.length,
      stationTiles: stationTiles.length,
      targets: spots.length,
      moved: 0,
      failed: [],
    }
    const assignedTargets = new Set()

    ids.forEach((id, idx) => {
      const fullName = resolveAgentName(id)
      const agent = this.scene.agents[fullName]
      if (!agent) {
        console.warn(`[Showrunner] Agent not found: ${id} (tried: ${fullName})`)
        allocationDebug.failed.push(`${fullName}: missing agent`)
        return
      }

      // Clean up existing movement and reservations before pathfinding
      if (this.scene.tweens) this.scene.tweens.killTweensOf(agent)
      this.clearAgentReservation(fullName)

      const pos = getGridPos(agent.x, agent.y)
      if (!pos || !Number.isFinite(pos.c) || !Number.isFinite(pos.r)) {
        console.warn(`[Showrunner] Missing grid position for ${fullName}`)
        allocationDebug.failed.push(`${fullName}: missing grid position`)
        return
      }

      const requestedEmote =
        arrivalEmotes?.[fullName] ||
        arrivalEmotes?.[id] ||
        arrivalEmotes?.default ||
        null

      let selectedTarget = null
      let selectedPath = null
      const orderedSpots = spots.slice(idx).concat(spots.slice(0, idx))
      for (const candidate of orderedSpots) {
        const key = tileKey(candidate)
        const reserver = this.reservedTiles.get(key)
        if (assignedTargets.has(key) || (reserver && reserver !== fullName)) continue

        const path = findPathToCoord(
          roomMap,
          pos.c, pos.r,
          candidate.c, candidate.r,
          this.reservedTiles,
          fullName
        )
        if (!path) continue

        selectedTarget = candidate
        selectedPath = path
        assignedTargets.add(key)
        break
      }

      if (!selectedTarget || !selectedPath) {
        const accepted = this.scene?.moveAgentToStation?.(
          fullName,
          normalizedLocation,
          MovePriority.USER,
          'showrunner:overflow-fallback'
        )
        if (accepted) {
          allocationDebug.moved += 1
          const fallbackEmote =
            arrivalEmotes?.[fullName] ||
            arrivalEmotes?.[id] ||
            arrivalEmotes?.default ||
            null
          if (fallbackEmote && this.scene?.time) {
            this.scene.time.delayedCall(1200, () => {
              this.scene.playAnimation(fullName, fallbackEmote)
            })
          }
        } else {
          console.warn(`[Showrunner] No reachable ${normalizedLocation} target for ${fullName}`)
          allocationDebug.failed.push(`${fullName}: no reachable target`)
        }
        return
      }

      this.reserveTile(selectedTarget.c, selectedTarget.r, fullName)
      allocationDebug.moved += 1

      this.scene.startPathMovement(agent, selectedPath, () => {
        this.releaseTile(selectedTarget.c, selectedTarget.r)
        this.scene.faceTarget(agent, spots[0])
        if (requestedEmote) {
          this.scene.playAnimation(fullName, requestedEmote)
        } else if (!preserveArrivalEmote) {
          this.scene.playAnimation(fullName, AnimStateType.TALK)
        }
      })
    })

    showrunnerLog('[Showrunner] Station move allocation:', allocationDebug)
  }

  /**
   * Play an emote on one or more agents
   */
  commandPlayEmote(agentIds, emote) {
    if (!agentIds) return
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds]
    
    ids.forEach(agentId => {
      const fullName = resolveAgentName(agentId)
      const agent = this.scene.agents[fullName]
      if (!agent) {
        console.warn(`[Showrunner] Agent "${fullName}" not found for emote`)
        return
      }
      this.scene.playAnimation(fullName, emote || AnimStateType.IDLE)
    })
  }

  getSeatTileKey(tile) {
    return `${tile.c},${tile.r}`
  }

  getRoomMap() {
    return Array.isArray(this.scene?.roomMap) ? this.scene.roomMap : []
  }

  isSeatWalkable(tile, roomMap = this.getRoomMap()) {
    if (!tile) return false
    const height = roomMap.length
    const width = roomMap[0]?.length || 0

    if (tile.r < 0 || tile.r >= height || tile.c < 0 || tile.c >= width) {
      return false
    }

    const cell = Number(roomMap[tile.r][tile.c])
    return (
      cell === TILE_TYPES.FLOOR ||
      cell === TILE_TYPES.RUG ||
      cell === TILE_TYPES.MONEY ||
      cell === TILE_TYPES.DOOR
    )
  }

  discoverDeskSeats() {
    const roomMap = this.getRoomMap()
    const seats = []

    for (let r = 0; r < roomMap.length; r++) {
      for (let c = 0; c < roomMap[0]?.length || 0; c++) {
        if (Number(roomMap[r][c]) !== TILE_TYPES.DESK) continue

        const startsTriplet =
          (c === 0 || Number(roomMap[r][c - 1]) !== TILE_TYPES.DESK) &&
          Number(roomMap[r][c + 1]) === TILE_TYPES.DESK &&
          Number(roomMap[r][c + 2]) === TILE_TYPES.DESK

        if (startsTriplet) {
          seats.push({ c: c + 1, r })
        }
      }
    }

    return seats.sort((a, b) => (a.r - b.r) || (a.c - b.c))
  }

  getPrimaryTableCluster() {
    const roomMap = this.getRoomMap()
    const height = roomMap.length
    const width = roomMap[0]?.length || 0
    const visited = new Set()
    const clusters = []

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const key = `${c},${r}`
        if (visited.has(key) || Number(roomMap[r][c]) !== TILE_TYPES.TABLE) continue

        const queue = [{ c, r }]
        const tiles = []
        visited.add(key)

        while (queue.length > 0) {
          const current = queue.shift()
          tiles.push(current)

          const neighbors = [
            { c: current.c + 1, r: current.r },
            { c: current.c - 1, r: current.r },
            { c: current.c, r: current.r + 1 },
            { c: current.c, r: current.r - 1 },
          ]

          neighbors.forEach((neighbor) => {
            if (
              neighbor.c < 0 ||
              neighbor.c >= width ||
              neighbor.r < 0 ||
              neighbor.r >= height
            ) {
              return
            }

            const neighborKey = `${neighbor.c},${neighbor.r}`
            if (visited.has(neighborKey) || Number(roomMap[neighbor.r][neighbor.c]) !== TILE_TYPES.TABLE) return

            visited.add(neighborKey)
            queue.push(neighbor)
          })
        }

        const center = {
          c: tiles.reduce((sum, tile) => sum + tile.c, 0) / tiles.length,
          r: tiles.reduce((sum, tile) => sum + tile.r, 0) / tiles.length,
        }

        clusters.push({ tiles, center })
      }
    }

    if (clusters.length === 0) return null

    const mapCenter = {
      c: (width - 1) / 2,
      r: (height - 1) / 2,
    }

    clusters.sort((a, b) => {
      if (b.tiles.length !== a.tiles.length) return b.tiles.length - a.tiles.length

      const aDist = ((a.center.c - mapCenter.c) ** 2) + ((a.center.r - mapCenter.r) ** 2)
      const bDist = ((b.center.c - mapCenter.c) ** 2) + ((b.center.r - mapCenter.r) ** 2)
      return aDist - bDist
    })

    return clusters[0]
  }

  getTableClusterForTile(tile) {
    if (!tile) return null

    const roomMap = this.getRoomMap()
    const height = roomMap.length
    const width = roomMap[0]?.length || 0
    const visited = new Set()

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const key = `${c},${r}`
        if (visited.has(key) || Number(roomMap[r][c]) !== TILE_TYPES.TABLE) continue

        const queue = [{ c, r }]
        const tiles = []
        visited.add(key)

        while (queue.length > 0) {
          const current = queue.shift()
          tiles.push(current)

          const neighbors = [
            { c: current.c + 1, r: current.r },
            { c: current.c - 1, r: current.r },
            { c: current.c, r: current.r + 1 },
            { c: current.c, r: current.r - 1 },
          ]

          neighbors.forEach((neighbor) => {
            if (
              neighbor.c < 0 ||
              neighbor.c >= width ||
              neighbor.r < 0 ||
              neighbor.r >= height
            ) {
              return
            }
            const neighborKey = `${neighbor.c},${neighbor.r}`
            if (visited.has(neighborKey) || Number(roomMap[neighbor.r][neighbor.c]) !== TILE_TYPES.TABLE) return
            visited.add(neighborKey)
            queue.push(neighbor)
          })
        }

        const includesTile = tiles.some((tableTile) => tableTile.c === tile.c && tableTile.r === tile.r)
        if (!includesTile) continue

        const center = {
          c: tiles.reduce((sum, tableTile) => sum + tableTile.c, 0) / tiles.length,
          r: tiles.reduce((sum, tableTile) => sum + tableTile.r, 0) / tiles.length,
        }
        return { tiles, center }
      }
    }

    return null
  }

  discoverTableSeats(cluster) {
    if (!cluster?.tiles?.length) {
      return { center: null, seats: [] }
    }

    const roomMap = this.getRoomMap()
    const clusterKeys = new Set(cluster.tiles.map((tile) => this.getSeatTileKey(tile)))
    const seatMap = new Map()

    cluster.tiles.forEach((tile) => {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue

          const candidate = { c: tile.c + dc, r: tile.r + dr }
          const candidateKey = this.getSeatTileKey(candidate)
          if (clusterKeys.has(candidateKey)) continue
          if (!this.isSeatWalkable(candidate, roomMap)) continue

          seatMap.set(candidateKey, candidate)
        }
      }
    })

    const seats = Array.from(seatMap.values()).sort((a, b) => (a.r - b.r) || (a.c - b.c))
    return { center: cluster.center, seats }
  }

  getOccupiedSeatKeys(excludedAgents = []) {
    const excluded = new Set(excludedAgents.map((agent) => resolveAgentName(agent)))
    const occupied = new Set()

    for (const [tileKey, reserver] of this.reservedTiles.entries()) {
      if (!excluded.has(resolveAgentName(reserver))) {
        occupied.add(tileKey)
      }
    }

    Object.entries(this.scene?.agents || {}).forEach(([agentName, agent]) => {
      if (!agent || excluded.has(agentName)) return
      const gridPos = getGridPos(agent.x, agent.y)
      occupied.add(this.getSeatTileKey(gridPos))
    })

    return occupied
  }

  allocateDeskOverflowSeats(agentIds) {
    const selectedAgents = (Array.isArray(agentIds) ? agentIds : [agentIds])
      .map((id) => resolveAgentName(id))
      .filter((name, index, arr) => name && this.scene?.agents?.[name] && arr.indexOf(name) === index)

    const occupiedSeatKeys = this.getOccupiedSeatKeys(selectedAgents)
    const deskSeats = this.discoverDeskSeats().filter((seat) => !occupiedSeatKeys.has(this.getSeatTileKey(seat)))
    const primaryTableCluster = this.getPrimaryTableCluster()
    const { center: tableCenter, seats: tableSeats } = this.discoverTableSeats(primaryTableCluster)
    const freeTableSeats = tableSeats.filter((seat) => !occupiedSeatKeys.has(this.getSeatTileKey(seat)))

    const assignments = []
    let deskIndex = 0
    let tableIndex = 0

    selectedAgents.forEach((agentName) => {
      if (deskIndex < deskSeats.length) {
        assignments.push({ agentName, station: 'desk', target: deskSeats[deskIndex++] })
        return
      }

      if (tableIndex < freeTableSeats.length) {
        assignments.push({ agentName, station: 'table', target: freeTableSeats[tableIndex++], faceTarget: tableCenter })
        return
      }

      assignments.push({ agentName, station: 'table', fallback: true, faceTarget: tableCenter })
    })

    return {
      assignments,
      deskCapacity: deskSeats.length,
      tableCapacity: freeTableSeats.length,
    }
  }

  moveAgentToSeat(agentName, target, station, faceTarget = null, source = 'showrunner:seat') {
    const fullName = resolveAgentName(agentName)
    const agent = this.scene?.agents?.[fullName]
    if (!agent || !target) return false

    if (this.scene.movementManager?.cancelMovement) {
      this.scene.movementManager.cancelMovement(fullName, `${source}:explicit-seat`)
    }

    if (this.scene.tweens) this.scene.tweens.killTweensOf(agent)
    agent.setScale(1)
    this.clearAgentReservation(fullName)

    const pos = getGridPos(agent.x, agent.y)
    const path = findPathToCoord(
      this.scene.roomMap,
      pos.c,
      pos.r,
      target.c,
      target.r,
      this.reservedTiles,
      fullName
    )

    if (!path) {
      return this.scene.moveAgentToStation?.(fullName, station, MovePriority.USER, `${source}:fallback`) || false
    }

    if (station === 'desk' && path.length > 0) {
      path[path.length - 1].y -= 8
    }

    this.reserveTile(target.c, target.r, fullName)

    this.scene.startPathMovement(agent, path, () => {
      this.releaseTile(target.c, target.r)

      if (station === 'desk') {
        agent.setFlipX(false)
        if (this.scene.animController) {
          this.scene.animController.setBaseState(fullName, AnimStateType.SIT_BACK)
        }
        this.scene.resetAgent(fullName)
        return
      }

      if (faceTarget) {
        this.scene.faceTarget(agent, faceTarget)
      }
      this.scene.playAnimation(fullName, AnimStateType.TALK, { blendDuration: 200 })
    })

    return true
  }

  /**
   * Return agents to their desks
   * Desk capacity is derived from the current map; overflow goes to the primary table cluster.
   */
  commandReturnToDesks(agentIds) {
    const { assignments, deskCapacity, tableCapacity } = this.allocateDeskOverflowSeats(agentIds)

    console.log('[Showrunner] Desk allocator:', {
      requested: Array.isArray(agentIds) ? agentIds.length : 1,
      deskCapacity,
      tableCapacity,
      assignments,
    })

    assignments.forEach(({ agentName, station, target, fallback, faceTarget }) => {
      if (fallback || !target) {
        this.scene.moveAgentToStation?.(agentName, 'table', MovePriority.USER, 'showrunner:desk-overflow')
        return
      }

      this.moveAgentToSeat(agentName, target, station, faceTarget, 'showrunner:desk-allocation')
    })
  }

  /**
   * Move agents to a specific station (cooler, table, tv, etc.)
   */
  commandStationMove(agentIds, station, options = {}) {
    if (!agentIds || !station) return
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds]
    const normalizedStation = normalizeStationKey(station)

    if (normalizedStation === 'desk') {
      this.commandReturnToDesks(ids)
    } else {
      this.commandMoveAgents(ids, normalizedStation, options)
    }
  }

  /**
   * Play error animation on agent
   */
  commandPlayError(agentId, emote = 'confused') {
    const fullName = resolveAgentName(agentId)
    this.scene.playAnimation(fullName, emote)
  }

  /**
   * Flash the camera with a color
   */
  commandFlashCamera(color = 0xffffff, duration = 500) {
    // Flash effects removed.
    return
  }

  /**
   * Clear all reservations for an agent
   */
  clearAgentReservation(agentId) {
    for (const [tile, holderId] of this.reservedTiles.entries()) {
      if (holderId === agentId) {
        this.reservedTiles.delete(tile)
      }
    }
  }

  /**
   * Reserve a tile for an agent
   */
  reserveTile(c, r, agentId) {
    this.reservedTiles.set(`${c},${r}`, agentId)
  }

  /**
   * Release a tile reservation
   */
  releaseTile(c, r) {
    this.reservedTiles.delete(`${c},${r}`)
  }

  // ============================================
  // TIER-BASED GATHERING METHODS (PHASE 2)
  // ============================================

  playTier3WhaleGathering(ticker, donor, amount) {
    console.log('[Showrunner] TIER 3 WHALE GATHERING:', { ticker, donor, amount })
    // Move all agents to the center table
    const allAgents = Object.keys(this.scene.agents)
    this.commandMoveAgents(allAgents, 'table')
    // Flash green for wealth
    this.commandFlashCamera(0x00ff00, 500)
  }

  completeTier3Gathering(action, confidence) {
    console.log('[Showrunner] TIER 3 GATHERING COMPLETE:', { action, confidence })
    // All agents return to desks
    const allAgents = Object.keys(this.scene.agents)
    this.commandReturnToDesks(allAgents)
  }

  // New 5-Tier Analysis Scenes

  playTier1Analysis(ticker) {
    console.log('[Showrunner] TIER 1 Analysis:', ticker)
    // Small flash, 1 agent to ticker stand (Market Analyst)
    this.commandMoveAgents(['Market Analyst'], 'newsstand')
    this.commandFlashCamera(0xffffff, 200)
  }

  playTier2Analysis(ticker, agents) {
    console.log('[Showrunner] TIER 2 Analysis:', ticker, agents)
    // 3 agents to table
    this.commandMoveAgents(agents || ['Market Analyst', 'Social Scout', 'News Lead'], 'table')
  }

  playTier3Analysis(ticker, agents) {
    console.log('[Showrunner] TIER 3 Analysis:', ticker, agents)
    // 5 agents to table
    this.commandMoveAgents(agents || ['Market Analyst', 'Social Scout', 'News Lead', 'Fundamentals Guy', 'Trader'], 'table')
  }

  playTier4Gathering(ticker, donor, amount) {
    console.log('[Showrunner] TIER 4 GATHERING:', { ticker, donor, amount })
    // 8 agents move to conference area
    const allAgents = Object.keys(this.scene.agents)
    this.commandMoveAgents(allAgents.slice(0, 8), 'table')
    this.commandFlashCamera(0x00ffff, 400)
  }

  playTier5WhaleGathering(ticker, donor, amount) {
    console.log('[Showrunner] TIER 5 WHALE GATHERING:', { ticker, donor, amount })
    // ALL agents move to conference area
    const allAgents = Object.keys(this.scene.agents)
    this.commandMoveAgents(allAgents, 'table')
    this.commandFlashCamera(0xff00ff, 600)
  }

  completeTierGathering(tier, action, confidence) {
    console.log(`[Showrunner] TIER ${tier} GATHERING COMPLETE:`, { action, confidence })
    const allAgents = Object.keys(this.scene.agents)
    this.commandReturnToDesks(allAgents)
  }

  // ============================================
  // PIPELINE STEP SCENE ORCHESTRATOR
  // ============================================

  /**
   * Orchestrates a specific step in the pipeline
   * @param {number} phase - Current pipeline phase (1-7)
   * @param {string[]} agents - List of primary agents for this phase
   * @param {string} location - Target gathering spot ('table', 'tv', etc)
   * @param {Object} animations - Map of { agent: emote }
   * @param {Object} agentStations - Override stations map
   * @param {Object} agentAnimations - Featured animations map
   * @param {Object} agentPaths - Custom path overrides
   * @param {boolean} highlight - Whether to pulse active agents
   * @param {string[]} highlightAgents - Optional subset of agents to highlight
   */
  playStepScene(
    phase,
    agents,
    location,
    animations,
    agentStations,
    agentAnimations,
    agentPaths,
    highlight = false,
    highlightAgents = null,
    directTargets = null
  ) {
    console.log(`[Showrunner] Playing Step Scene for Phase ${phase}:`, { 
      agents, location, highlight, highlightAgents
    })

    // 1. Highlighting - Pulse the active agents on the canvas
    if (this.scene && typeof this.scene.highlightAgents === 'function') {
      const targets = Array.isArray(highlightAgents) && highlightAgents.length > 0
        ? highlightAgents
        : agents
      this.scene.highlightAgents(targets, highlight)
    }

    const roomMap = this.scene?.getRoomMap?.() || this.scene?.roomMap || []

    const resolvePathStyle = (value) => {
      if (value === undefined || value === null) return 'direct'
      if (typeof value === 'number') return PATH_STYLE_CODES[value] || 'direct'
      const normalized = String(value).trim().toLowerCase()
      const numeric = Number(normalized)
      if (!Number.isNaN(numeric) && PATH_STYLE_CODES[numeric]) {
        return PATH_STYLE_CODES[numeric]
      }
      return normalized || 'direct'
    }

    const pickDetourStation = (target) => {
      const options = DETOUR_STATIONS.filter((station) => station !== target)
      if (options.length === 0) return target
      return options[Math.floor(Math.random() * options.length)]
    }

    const queueStationMove = (agentId, station, delayMs, options = {}) => {
      if (!this.scene?.time) return
      this.scene.time.delayedCall(delayMs, () => {
        this.commandStationMove([agentId], resolvePlayableStation(agentId, station), options)
      })
    }

    const moveToNearestFloor = (agentId) => {
      const fullName = resolveAgentName(agentId)
      const agent = this.scene?.agents?.[fullName]
      const fromPos = agent ? getGridPos(agent.x, agent.y) : null
      const target = findNearestWalkableTile(roomMap, fromPos)
      if (!target) {
        console.warn(`[Showrunner] No walkable fallback available for ${fullName}`)
        return
      }
      this.commandMoveAgent(fullName, target)
    }

    const resolvePlayableStation = (agentId, requestedStation) => {
      const normalizedTarget = normalizeStationKey(requestedStation)
      if (hasStationTiles(roomMap, normalizedTarget)) return normalizedTarget

      const normalizedLocation = normalizeStationKey(location)
      if (normalizedLocation && hasStationTiles(roomMap, normalizedLocation)) {
        console.warn(`[Showrunner] ${agentId} station "${normalizedTarget}" missing; using scene location "${normalizedLocation}"`)
        return normalizedLocation
      }

      if (hasStationTiles(roomMap, 'desk')) {
        console.warn(`[Showrunner] ${agentId} station "${normalizedTarget}" missing; using desk fallback`)
        return 'desk'
      }

      console.warn(`[Showrunner] ${agentId} station "${normalizedTarget}" missing; using nearest floor fallback`)
      return null
    }

    const getArrivalEmote = (agentId) => (
      (agentAnimations || animations || {})?.[agentId] ||
      (agentAnimations || animations || {})?.[resolveAgentName(agentId)] ||
      (agentAnimations || animations || {})?.default ||
      null
    )

    const createMoveOptions = (agentId) => {
      const arrivalEmote = getArrivalEmote(agentId)
      const arrivalEmotes = {}
      if (arrivalEmote) {
        arrivalEmotes[agentId] = arrivalEmote
        arrivalEmotes[resolveAgentName(agentId)] = arrivalEmote
      }
      return { arrivalEmotes, preserveArrivalEmote: Boolean(arrivalEmote) }
    }

    const directMoveGroups = new Map()
    const addDirectMove = (station, agentId) => {
      const normalizedStation = normalizeStationKey(station)
      if (!directMoveGroups.has(normalizedStation)) {
        directMoveGroups.set(normalizedStation, {
          agents: [],
          arrivalEmotes: {},
          preserveArrivalEmote: false,
        })
      }
      const group = directMoveGroups.get(normalizedStation)
      group.agents.push(agentId)

      const arrivalEmote = getArrivalEmote(agentId)
      if (arrivalEmote) {
        group.arrivalEmotes[agentId] = arrivalEmote
        group.arrivalEmotes[resolveAgentName(agentId)] = arrivalEmote
        group.preserveArrivalEmote = true
      }
    }

    const moveWithStyle = (agentId, targetStation, style) => {
      if (!targetStation) return
      const directTarget = directTargets?.[agentId] || directTargets?.[resolveAgentName(agentId)]
      if (directTarget) {
        this.commandMoveAgent(agentId, directTarget)
        return
      }
      const playableStation = resolvePlayableStation(agentId, targetStation)
      if (!playableStation) {
        moveToNearestFloor(agentId)
        return
      }
      const resolved = resolvePathStyle(style)
      const moveOptions = createMoveOptions(agentId)
      if (resolved === 'idle') {
        return
      }
      if (resolved === 'direct') {
        addDirectMove(playableStation, agentId)
        return
      }
      const detour1 = resolvePlayableStation(agentId, pickDetourStation(playableStation)) || playableStation
      if (resolved === 'detour') {
        this.commandStationMove([agentId], detour1, moveOptions)
        queueStationMove(agentId, playableStation, 1800, moveOptions)
        return
      }
      if (resolved === 'loop') {
        const detour2 = resolvePlayableStation(agentId, pickDetourStation(playableStation)) || playableStation
        this.commandStationMove([agentId], detour1, moveOptions)
        queueStationMove(agentId, detour2, 1600, moveOptions)
        queueStationMove(agentId, playableStation, 3200, moveOptions)
        return
      }
      this.commandStationMove([agentId], playableStation, moveOptions)
    }

    // 2. Logic to move agents to location or stations with path style
    const targets = {}
    if (agentStations && Object.keys(agentStations).length) {
      Object.entries(agentStations).forEach(([agent, station]) => {
        targets[agent] = station
      })
    } else if (location && agents?.length) {
      agents.forEach((agent) => {
        targets[agent] = location
      })
    }

    Object.entries(targets).forEach(([agent, station]) => {
      const style = agentPaths?.[agent] || agentPaths?.default || 'direct'
      moveWithStyle(agent, station, style)
    })

    directMoveGroups.forEach((group, station) => {
      this.commandStationMove(group.agents, station, {
        arrivalEmotes: group.arrivalEmotes,
        preserveArrivalEmote: group.preserveArrivalEmote,
      })
    })

    // 3. Optional: Play animations/emotes
    const emotes = agentAnimations || animations
    if (emotes) {
      const applyEmotes = () => {
        Object.entries(emotes).forEach(([agent, emote]) => {
          this.commandPlayEmote([agent], emote)
        })
      }
      setTimeout(applyEmotes, 1500)
      setTimeout(applyEmotes, 3400)
    }
  }

  completeStepScene(phase) {
    console.log(`[Showrunner] Step Scene Complete for Phase ${phase}`)
    // We don't always return to desks here, wait for next step or end
  }

  // ============================================
  // BLUEPRINT MODE (Debug/God Mode)
  // ============================================

  toggleBlueprintMode(enabled) {
    return
  }

  drawBlueprintOverlay() {
    return
  }

  clearBlueprints() {
    return
  }

  exportBlueprintContext() {
    return {}
  }

  // ============================================
  // ANNOTATION SYSTEM
  // ============================================

  setAnnotationTool(tool) {
    return
  }

  setAnnotationColor(color) {
    return
  }

  setAnnotationWidth(width) {
    return
  }

  undoAnnotation() {
    return
  }

  exportScreenshot() {
    return
  }

  moveAgentTo(agentId, x, y) {
    const fullName = resolveAgentName(agentId)
    const agent = this.scene.agents[fullName]
    if (agent) {
      agent.x = x
      agent.y = y
      console.log(`[Showrunner] Force moved ${fullName} to ${x}, ${y}`)
    }
  }

  // ============================================
  // DEBUG HELPERS
  // ============================================

  toggleDebug() {
    return
  }

  update() {
    return
  }

  drawDebugOverlay() {
    return
  }

  /**
   * Cleanup on scene destruction
   */
  destroy() {
    console.log('[Showrunner] Cleaning up event listeners and graphics')
    this.eventListeners.forEach(({ event, handler }) => {
      window.removeEventListener(event, handler)
    })
    this.eventListeners = []
  }
}

// Export standalone helper functions for React components to dispatch events
export const dispatchSceneCommand = (cmd) => {
  const event = new CustomEvent('SCENE_COMMAND', { detail: cmd })
  window.dispatchEvent(event)
}

export const broadcastSceneCommand = async (cmd) => {
  if (!cmd || !cmd.type) {
    console.warn('[Showrunner] Invalid broadcast command:', cmd)
    return false
  }

  dispatchSceneCommand(cmd)
  try {
    const response = await fetch('/api/admin/scene_command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    })
    if (!response.ok) {
      // TA-only runtime intentionally does not support manual scene command persistence.
      if (response.status === 501) {
        return true
      }
      throw new Error(`${response.status} ${response.statusText}`)
    }
    return true
  } catch (error) {
    console.error('[Showrunner] Failed to broadcast scene command to backend:', error)
    return true
  }
}

