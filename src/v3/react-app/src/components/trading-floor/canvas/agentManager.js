import { AGENTS, AGENT_STATIONS, TILE_SIZE, ROOM_MAP, STATION_TILE_MAP } from '../../../utils/constants'
import { getGridPos, findNearestTile, findPathToCoord } from './pathfinding'

/**
 * Create agent sprites in the scene
 * @param {Phaser.Scene} scene - The Phaser scene
 * @returns {Object} Object mapping agent names to sprites
 */
export function createAgentSprites(scene) {
  const agents = {}

  Object.entries(AGENTS).forEach(([name, config]) => {
    const key = `agent_${name.toLowerCase()}`
    const agent = scene.add.sprite(config.position.x, config.position.y, key)
    agent.setDepth(agent.y)
    agent.play(`${key}_idle`)

    agent.agentName = name
    agent.personality = config.personality
    agent.homePos = getGridPos(agent.x, agent.y)
    agent.fatigue = 0
    agent.status = 'idle'
    agent.active = true

    agents[name] = agent
  })

  return agents
}

/**
 * Move an agent to a specific station type
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {string} agentName - Name of the agent
 * @param {string} stationType - Type of station (desk, scanner, tv, cooler, table)
 * @param {Object} agents - Agent sprites object
 */
export function moveAgentToStation(scene, agentName, stationType, agents) {
  const agent = agents[agentName]
  if (!agent) return

  const tileType = STATION_TILE_MAP[stationType]
  if (tileType === undefined) return

  const pos = getGridPos(agent.x, agent.y)
  const target = findNearestTile(ROOM_MAP, pos, tileType)
  if (!target) return

  // Get reserved tiles from showrunner for collision avoidance
  const reservedTiles = scene.showrunner?.reservedTiles || null
  const path = findPathToCoord(ROOM_MAP, pos.c, pos.r, target.c, target.r, reservedTiles, agentName)
  if (path) {
    // Reserve destination
    if (scene.showrunner) {
      scene.showrunner.reserveTile(target.c, target.r, agentName)
    }
    startAgentPathMovement(scene, agent, path, () => {
      // Release reservation
      if (scene.showrunner) {
        scene.showrunner.releaseTile(target.c, target.r)
      }
    })

    // Set animation based on station
    const key = `agent_${agentName.toLowerCase()}`
    if (stationType === 'desk') {
      agent.play(`${key}_sit_back`, true)
    } else if (stationType === 'scanner') {
      agent.play(`${key}_sit_type`, true)
    } else if (stationType === 'tv') {
      agent.play(`${key}_read`, true)
    } else if (stationType === 'cooler') {
      agent.play(`${key}_drink`, true)
    }
  }
}

/**
 * Start agent path movement with animations
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {Phaser.GameObjects.Sprite} agent - The agent sprite
 * @param {Array} path - Path array
 * @param {Function} onComplete - Callback when movement completes
 */
export function startAgentPathMovement(scene, agent, path, onComplete) {
  if (!path || path.length === 0) {
    if (onComplete) onComplete()
    return
  }

  let stepIdx = 0
  const moveNext = () => {
    if (stepIdx >= path.length) {
      const key = `agent_${agent.agentName.toLowerCase()}`
      agent.play(`${key}_idle`, true)
      if (onComplete) onComplete()
      return
    }

    const p = path[stepIdx]
    stepIdx++

    const key = `agent_${agent.agentName.toLowerCase()}`
    const dx = p.x - agent.x
    const dy = p.y - agent.y

    if (Math.abs(dy) > Math.abs(dx)) {
      agent.play(dy > 0 ? `${key}_walk_down` : `${key}_walk_up`, true)
    } else {
      agent.play(`${key}_walk_side`, true)
      agent.setFlipX(dx < 0)
    }

    scene.tweens.add({
      targets: agent,
      x: p.x,
      y: p.y,
      duration: 200,
      ease: 'Linear',
      onComplete: moveNext
    })
  }

  moveNext()
}

/**
 * Get agent position
 * @param {Object} agents - Agent sprites object
 * @param {string} agentName - Name of the agent
 * @returns {{x: number, y: number}|null} Position or null
 */
export function getAgentPosition(agents, agentName) {
  const agent = agents[agentName]
  if (agent) {
    return { x: agent.x, y: agent.y }
  }
  return null
}

/**
 * Update agent depths
 * @param {Object} agents - Agent sprites object
 */
export function updateAgents(agents) {
  Object.values(agents).forEach(agent => {
    if (agent.active) {
      agent.setDepth(agent.y)
    }
  })
}
