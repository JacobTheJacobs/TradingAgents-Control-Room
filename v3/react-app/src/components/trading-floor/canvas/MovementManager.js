// MovementManager.js — Single source of truth for all agent movement
// Provides priority-based cancellable movement commands
// Prevents overlapping tween chains and leaked tile reservations

import { STATION_TILE_MAP, ROOM_MAP, GATHER_SPOTS, TILE_TYPES } from '../../../utils/constants'
import { getGridPos, findPathToCoord, isWalkable } from './pathfinding'
import { AnimStateType } from './animation'

/**
 * Movement priority levels.
 * Higher number = higher priority = can override lower.
 */
export const MovePriority = {
  IDLE: 1,        // IdleBehaviorEngine, GossipEngine
  AUTOMATED: 2,   // WebSocket, DataFetchAnimator, ConsensusScene
  USER: 3,        // Admin panel, DevToolsPanel direct commands
}

/**
 * Station → animation mapping for arrival poses
 */
const STATION_ARRIVAL_ANIM = {
  'desk': AnimStateType.SIT_BACK,
  'scanner': AnimStateType.SIT_TYPE,
  'tv': AnimStateType.READ,
  'cooler': AnimStateType.DRINK,
  'table': AnimStateType.TALK,
  'ticker': AnimStateType.SIT_TYPE,
  'newsstand': AnimStateType.READ,
  'window': AnimStateType.IDLE,
}

export class MovementManager {
  /**
   * @param {Phaser.Scene} scene — the TradingFloorScene instance
   */
  constructor(scene) {
    this.scene = scene
    // agentName -> { station, priority, source, destinationTile, onCancel }
    this.activeMovements = new Map()
    // Debounce tracking: agentName -> { station, timestamp }
    this.lastCommands = new Map()

    console.log('[MovementManager] Initialized')
  }

  getRoomMap() {
    const runtimeMap = this.scene?.roomMap
    if (Array.isArray(runtimeMap) && runtimeMap.length > 0 && Array.isArray(runtimeMap[0])) {
      return runtimeMap
    }
    if (typeof window !== 'undefined') {
      const globalMap = window.ROOM_MAP
      if (Array.isArray(globalMap) && globalMap.length > 0 && Array.isArray(globalMap[0])) {
        return globalMap
      }
    }
    return ROOM_MAP
  }

  /**
   * Move an agent to a station with priority handling.
   *
   * @param {string} agentName  — full agent name (e.g. "Market Analyst")
   * @param {string} station    — station key (e.g. "scanner", "cooler", "ticker")
   * @param {number} priority   — MovePriority value
   * @param {string} source     — caller identifier for debugging
   * @returns {boolean} true if command was accepted, false if rejected
   */
  moveAgent(agentName, station, priority = MovePriority.AUTOMATED, source = 'unknown') {
    try {
      // ── Debounce: reject duplicate commands within 300ms ──
      const now = Date.now()
      const last = this.lastCommands.get(agentName)
      if (last && last.station === station && (now - last.timestamp) < 300) {
        console.log(`[MovementManager] Debounced duplicate ${source} move for ${agentName} → ${station}`)
        return false
      }
      this.lastCommands.set(agentName, { station, timestamp: now })

      // ── Priority check ──
      const current = this.activeMovements.get(agentName)
      if (current && current.priority > priority) {
        console.log(`[MovementManager] Rejecting ${source} move for ${agentName} (priority ${priority} < ${current.priority})`)
        return false
      }

      // ── Cancel existing movement with full cleanup ──
      if (current) {
        this.cancelMovement(agentName, `overridden by ${source}`)
      }

      // ── Resolve station to tile type and find path ──
      const agent = this.scene.agents[agentName]
      if (!agent) {
        console.warn(`[MovementManager] Agent not found: ${agentName}`)
        return false
      }

      const tileType = STATION_TILE_MAP[station]
      if (tileType === undefined) {
        console.warn(`[MovementManager] Unknown station: ${station}`)
        return false
      }

      // Kill any existing tweens before pathfinding
      if (this.scene.tweens) this.scene.tweens.killTweensOf(agent)
      
      // Reset any modifying scales (like newsstand nodding)
      agent.setScale(1)

      // Clear any existing tile reservation for this agent
      if (this.scene.showrunner?.clearAgentReservation) {
        this.scene.showrunner.clearAgentReservation(agentName)
      }

      const agentPos = getGridPos(agent.x, agent.y)
      const reservedTiles = this.scene.showrunner?.reservedTiles || new Map()

      const roomMap = this.getRoomMap()

      // Find ALL tiles of this type
      const possibleTiles = []
      for (let r = 0; r < roomMap.length; r++) {
        for (let c = 0; c < roomMap[0].length; c++) {
          if (roomMap[r][c] === tileType) {
            if (station === 'desk') {
              let contiguousDesksBefore = 0;
              for (let i = c - 1; i >= 0; i--) {
                if (roomMap[r][i] === TILE_TYPES.DESK) contiguousDesksBefore++;
                else break;
              }
              // Only push the middle tile of the 3-tile desk (1 contiguous desk before it)
              if (contiguousDesksBefore % 3 === 1) {
                possibleTiles.push({ c, r })
              }
            } else {
              possibleTiles.push({ c, r })
            }
          }
        }
      }

      if (possibleTiles.length === 0) {
        console.warn(`[MovementManager] No tile of type ${station} found on map`)
        return false
      }

      // ── Step 1: Check predefined GATHER_SPOTS ──
      let bestNeighbor = null
      let minDist = 999

      // DESK specific logic: Only one agent near any desk tile
      if (station === 'desk') {
        const freeDesks = possibleTiles.filter(dt => {
          const key = `${dt.c},${dt.r}`
          const reserver = reservedTiles.get(key)
          // If the exact center desk tile is reserved by someone else, it's taken
          return !reserver || reserver === agentName
        });

        if (freeDesks.length === 0) {
          console.log(`[MovementManager] ${agentName} requested desk but all are occupied. Falling back to table.`);
          return this.moveAgent(agentName, 'table', priority, source);
        }

        // Pick the closest free desk directly and set it as bestNeighbor to skip the fallback neighbor search
        let closestDesk = null;
        let cDist = 9999;
        freeDesks.forEach(dt => {
          const d = Math.abs(agentPos.c - dt.c) + Math.abs(agentPos.r - dt.r);
          if (d < cDist) {
            cDist = d;
            closestDesk = dt;
          }
        });

        if (closestDesk) {
          bestNeighbor = closestDesk;
          minDist = cDist;
        }

        // Restrict possible tiles to ONLY free desks
        possibleTiles.splice(0, possibleTiles.length, ...freeDesks);
      }

      const gatherSpots = this.scene?.getGatherSpots?.(station) || GATHER_SPOTS[station]
      if (gatherSpots) {
        gatherSpots.forEach(spot => {
          if (isWalkable(spot.c, spot.r, reservedTiles, agentName, roomMap)) {
            const key = `${spot.c},${spot.r}`
            const reserver = reservedTiles.get(key)
            // If not reserved, or reserved by ME, it's a candidate
            if (!reserver || reserver === agentName) {
              const d = Math.abs(agentPos.c - spot.c) + Math.abs(agentPos.r - spot.r)
              if (d < minDist) {
                minDist = d
                bestNeighbor = spot
              }
            }
          }
        })
      }

      // ── Step 2: Fallback to any directly neighboring tile of the station ──
      // Desks do not allow fallback; you must sit at the desk itself.
      if (!bestNeighbor && station !== 'desk') {
        possibleTiles.forEach(tile => {
          const neighbors = [
            { c: tile.c + 1, r: tile.r }, { c: tile.c - 1, r: tile.r },
            { c: tile.c, r: tile.r + 1 }, { c: tile.c, r: tile.r - 1 },
            { c: tile.c + 1, r: tile.r + 1 }, { c: tile.c - 1, r: tile.r - 1 },
            { c: tile.c + 1, r: tile.r - 1 }, { c: tile.c - 1, r: tile.r + 1 }
          ]

          neighbors.forEach(n => {
            if (isWalkable(n.c, n.r, reservedTiles, agentName, roomMap)) {
              const key = `${n.c},${n.r}`
              const reserver = reservedTiles.get(key)
              if (!reserver || reserver === agentName) {
                const d = Math.abs(agentPos.c - n.c) + Math.abs(agentPos.r - n.r)
                if (d < minDist) {
                  minDist = d
                  bestNeighbor = n
                }
              }
            }
          })
        })
      }

      // ── Step 3: OVERFLOW: Search outward if still no spot found ──
      if (!bestNeighbor && station !== 'desk') {
        console.log(`[MovementManager] All ${station} direct spots full/blocked for ${agentName}, searching outward...`)
        // Anchored at the first possible tile of the station, search for ANY nearby walkable tile
        const anchor = possibleTiles[0]
        const queue = [{ c: anchor.c, r: anchor.r, d: 0 }]
        const visited = new Set([`${anchor.c},${anchor.r}`])
        let safetyCount = 0

        while (queue.length > 0 && safetyCount < 200) {
          const curr = queue.shift()
          safetyCount++

          // Is this a valid parking spot?
          if (isWalkable(curr.c, curr.r, reservedTiles, agentName, roomMap)) {
            const key = `${curr.c},${curr.r}`
            const reserver = reservedTiles.get(key)
            // MUST be unreserved (or mine) and NOT the station tile itself (prevents standing on station)
            const isStation = possibleTiles.some(t => t.c === curr.c && t.r === curr.r)
            if ((!reserver || reserver === agentName) && !isStation) {
              bestNeighbor = { c: curr.c, r: curr.r }
              break
            }
          }

          // Search 4-way neighbors
          const dirs = [{ c: 1, r: 0 }, { c: -1, r: 0 }, { c: 0, r: 1 }, { c: 0, r: -1 }]
          for (const dir of dirs) {
            const nc = curr.c + dir.c
            const nr = curr.r + dir.r
            const nKey = `${nc},${nr}`
            if (!visited.has(nKey) && nc >= 0 && nc < roomMap[0].length && nr >= 0 && nr < roomMap.length) {
              visited.add(nKey)
              queue.push({ c: nc, r: nr, d: curr.d + 1 })
            }
          }
        }
      }

      if (!bestNeighbor) {
        console.warn(`[MovementManager] CRITICAL: Could not find any walkable spot near ${station} for ${agentName}`)
        return false
      }

      const finalTarget = bestNeighbor

      // For USER-initiated movements (Puppet Master), we relax pathfinding and ignore other reservations
      // to ensure the command always executes even in dense clusters.
      const pathfindingReservations = priority >= MovePriority.USER ? null : reservedTiles;

      const path = findPathToCoord(roomMap, agentPos.c, agentPos.r, finalTarget.c, finalTarget.r, pathfindingReservations, agentName)

      if (!path) {
        console.warn(`[MovementManager] No path for ${agentName} → ${station} (${source}) even though neighbor was found`)
        return false
      }

      // Shift seated agents upward, but keep more torso visible for the live floor read.
      if (station === 'desk' && path.length > 0) {
        path[path.length - 1].y -= 8;
      }

      // ── Reserve destination tile ──
      if (this.scene.showrunner) {
        this.scene.showrunner.reserveTile(finalTarget.c, finalTarget.r, agentName)
      }

      // Reset base state to IDLE when starting any movement (they are standing/walking)
      if (this.scene.animController) {
        this.scene.animController.setBaseState(agentName, AnimStateType.IDLE);
      }

      // ── Track this movement ──
      this.activeMovements.set(agentName, {
        station,
        priority,
        source,
        destinationTile: finalTarget,
      })

      console.log(`[MovementManager] ✓ ${source} move accepted: ${agentName} → ${station} (priority ${priority})`)

      // ── Execute movement via scene's startPathMovement ──
      this.scene.startPathMovement(agent, path, () => {
        // Only process completion if this movement is still the active one
        const stillActive = this.activeMovements.get(agentName)
        if (!stillActive || stillActive.source !== source || stillActive.station !== station) {
          // This movement was cancelled/overridden — tile already cleaned up by cancelMovement
          return
        }

        // Release tile reservation
        if (this.scene.showrunner) {
          this.scene.showrunner.releaseTile(finalTarget.c, finalTarget.r)
        }

        // --- Determine Facing Direction & Arrival Anim ---
        let animKey = STATION_ARRIVAL_ANIM[station] || AnimStateType.IDLE

        // Find the actual station tiles to face
        const stationTiles = []
        for (let r = 0; r < roomMap.length; r++) {
          for (let c = 0; c < roomMap[0].length; c++) {
            if (roomMap[r][c] === STATION_TILE_MAP[station]) {
              stationTiles.push({ c, r })
            }
          }
        }

        let forceFrame = null

        if (stationTiles.length > 0) {
          // Calculate center of gravity of the station
          let centerC = 0, centerR = 0;
          stationTiles.forEach(st => {
            centerC += st.c;
            centerR += st.r;
          });
          centerC /= stationTiles.length;
          centerR /= stationTiles.length;

          const dx = centerC - finalTarget.c
          const dy = centerR - finalTarget.r

          // For generic directional flipping
          if (dx !== 0) {
            agent.setFlipX(dx < 0);
          } else {
            if (finalTarget.c > 10) agent.setFlipX(true);
            else agent.setFlipX(false);
          }

          // Special hardcoded frames to ensure they face correctly without locking out action animations
          if (station === 'desk') {
            animKey = AnimStateType.SIT_BACK;
            agent.setFlipX(false);
            
            // Apply the seated offset with enough lift for the chair mask, but not so much
            // that the desk reduces the sprite to a face-only read.
            const gridPos = getGridPos(agent.x, agent.y);
            const targetY = (gridPos.r * 32) + 16 - 8;
            agent.setY(targetY);
            agent.setDepth(targetY);
            
            // Set base state for this agent - they are now seated
            if (this.scene.animController) {
              this.scene.animController.setBaseState(agentName, AnimStateType.SIT_BACK);
            }
          } else if (station === 'table' || station === 'cooler') {
            // For circular tables/coolers, if they approach from top/bottom we use IDLE up/down
            if (Math.abs(dy) > Math.abs(dx)) {
              animKey = AnimStateType.IDLE;
              forceFrame = (dy < 0) ? 8 : 0;
            }
          } else if (station === 'tv') {
            // TVs are always UP on the wall. READ animation is down-facing.
            // We MUST force IDLE UP so they actually look at the screen.
            animKey = AnimStateType.IDLE;
            forceFrame = 8;
            agent.setFlipX(false);
          } else if (station === 'scanner') {
            // Scanners are usually side-approached. 
            // SIT_TYPE handles left/right perfectly via flipX.
            agent.setFlipX(dx < 0);
          } else if (station === 'newsstand') {
            // Newsstand: face the station exactly depending on arrival angle
            animKey = AnimStateType.IDLE;
            if (Math.abs(dy) > Math.abs(dx)) {
              // Vertical approach
              forceFrame = (dy < 0) ? 8 : 0; // 8 = UP, 0 = DOWN
              agent.setFlipX(false);
            } else {
              // Horizontal approach
              forceFrame = 4; // 4 = SIDE
              agent.setFlipX(dx < 0); // true for LEFT, false for RIGHT
            }

            // Simulate nodding/reading by slightly animating the Y scale
            agent.scene.tweens.add({
              targets: agent,
              scaleY: 0.95,
              duration: 400,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.easeInOut'
            });
          }

          console.log(`[MovementManager] ${agentName} arrived at ${station} facing target (dx: ${dx.toFixed(2)}, dy: ${dy.toFixed(2)})`)
        } else {
          console.log(`[MovementManager] ${agentName} arrived at ${station}`)
        }

        // Play arrival animation
        if (this.scene.animController && agent.agentName) {
          this.scene.animController.play(agent.agentName, animKey, { blendDuration: 200 })
        } else {
          this.scene.playAnimation?.(agentName, animKey, { blendDuration: 200 })
        }

        // Force static frame if applicable
        if (forceFrame !== null) {
          setTimeout(() => {
            if (agent && agent.active && agent.anims) {
              agent.stop()
              agent.setFrame(forceFrame)
            }
          }, 50)
        }

        // Play Sonar Ripple on arrival
        if (this.scene.createSonarRipple) {
          const rippleColor = station === 'desk' ? 0x00ff41 : 0x22d3ee;
          this.scene.createSonarRipple(agent.x, agent.y, rippleColor);
        }

        // Clear movement tracking
        this.activeMovements.delete(agentName)
      })

      return true
    } catch (err) {
      console.error(`[MovementManager] Error in moveAgent for ${agentName}:`, err)
      return false
    }
  }

  /**
   * Cancel an in-progress movement with proper cleanup.
   * @param {string} agentName
   * @param {string} reason — for logging
   */
  cancelMovement(agentName, reason = 'cancelled') {
    const movement = this.activeMovements.get(agentName)
    if (!movement) return

    console.log(`[MovementManager] Cancelling ${agentName} movement: ${reason}`)

    const agent = this.scene.agents[agentName]

    // Kill the tween chain
    if (agent && this.scene.tweens) {
      this.scene.tweens.killTweensOf(agent)
    }

    // Release the destination tile reservation (prevents leaks!)
    if (movement.destinationTile && this.scene.showrunner) {
      this.scene.showrunner.releaseTile(movement.destinationTile.c, movement.destinationTile.r)
    }

    // Clear tracking
    this.activeMovements.delete(agentName)
  }

  /**
   * Check if an agent has an active movement of at least the given priority.
   * Used by IdleBehaviorEngine to skip busy agents.
   */
  isAgentBusy(agentName, minPriority = MovePriority.AUTOMATED) {
    const movement = this.activeMovements.get(agentName)
    return movement && movement.priority >= minPriority
  }

  /**
   * Get the current movement info for an agent (for debugging).
   */
  getMovementInfo(agentName) {
    return this.activeMovements.get(agentName) || null
  }

  /**
   * Cancel all active movements (e.g. on scene shutdown).
   */
  cancelAll(reason = 'shutdown') {
    for (const agentName of this.activeMovements.keys()) {
      this.cancelMovement(agentName, reason)
    }
  }

  /**
   * Cleanup on scene destroy.
   */
  destroy() {
    this.cancelAll('destroy')
    this.activeMovements.clear()
    this.lastCommands.clear()
    console.log('[MovementManager] Destroyed')
  }
}
