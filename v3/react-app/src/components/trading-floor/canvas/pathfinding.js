// Pathfinding utilities for Trading Floor
import { TILE_SIZE, ROOM_MAP, TILE_TYPES } from '../../../utils/constants'

// Some props are taller than their 32x32 collision tile and visually spill into the
// walkable tile directly in front of them. If we allow routing onto that tile, agents
// appear to stand inside the object even though the map says the tile is "free".
const VISUAL_CLEARANCE_RULES = {
  [TILE_TYPES.PLANT]: [{ c: 0, r: 1 }],
  [TILE_TYPES.CABINET]: [{ c: 0, r: 1 }],
}

function getActiveRoomMap(roomMap = null) {
  if (Array.isArray(roomMap) && roomMap.length > 0 && Array.isArray(roomMap[0])) {
    return roomMap
  }
  if (typeof window !== 'undefined') {
    const runtimeMap = window.ROOM_MAP
    if (Array.isArray(runtimeMap) && runtimeMap.length > 0 && Array.isArray(runtimeMap[0])) {
      return runtimeMap
    }
  }
  return ROOM_MAP
}

function isBlockedByVisualOverhang(c, r, roomMap = null) {
  const activeMap = getActiveRoomMap(roomMap)
  const entries = Object.entries(VISUAL_CLEARANCE_RULES)
  for (const [tileTypeRaw, offsets] of entries) {
    const tileType = Number(tileTypeRaw)
    for (const offset of offsets) {
      const sourceC = c - offset.c
      const sourceR = r - offset.r
      if (sourceR < 0 || sourceR >= activeMap.length || sourceC < 0 || sourceC >= activeMap[0].length) {
        continue
      }
      if (Number(activeMap[sourceR][sourceC]) === tileType) {
        return true
      }
    }
  }
  return false
}

/**
 * Convert pixel position to grid coordinates
 * @param {number} x - Pixel x position
 * @param {number} y - Pixel y position
 * @returns {{c: number, r: number}} Grid column and row
 */
export function getGridPos(x, y) {
  return { c: Math.floor(x / TILE_SIZE), r: Math.floor(y / TILE_SIZE) }
}

/**
 * Check if a tile is walkable
 * @param {number} c - Grid column
 * @param {number} r - Grid row
 * @param {Map|null} reservedTiles - Optional map of reserved tiles ("c,r" -> agentId)
 * @param {string|null} excludeAgent - Agent ID to exclude from reservation check (own reservation)
 * @returns {boolean} True if walkable
 */
export function isWalkable(c, r, reservedTiles = null, excludeAgent = null, roomMap = null) {
  const activeMap = getActiveRoomMap(roomMap)
  if (r < 0 || r >= activeMap.length || c < 0 || c >= activeMap[0].length) return false
  const t = Number(activeMap[r][c])
  if (t !== TILE_TYPES.FLOOR && t !== TILE_TYPES.RUG && t !== TILE_TYPES.MONEY && t !== TILE_TYPES.DOOR) return false
  if (isBlockedByVisualOverhang(c, r, activeMap)) return false
  
  // Check if tile is reserved by another agent
  if (reservedTiles) {
    const key = `${c},${r}`
    const reserver = reservedTiles.get(key)
    if (reserver && reserver !== excludeAgent) {
      return false // Tile is reserved by another agent
    }
  }
  
  return true
}

/**
 * Find path from current position to target grid coordinates using BFS
 * @param {Object} roomMap - The room map array
 * @param {number} startC - Start column
 * @param {number} startR - Start row
 * @param {number} targetC - Target column
 * @param {number} targetR - Target row
 * @param {Map|null} reservedTiles - Optional map of reserved tiles
 * @param {string|null} excludeAgent - Agent ID to exclude from reservation check
 * @returns {Array|null} Array of path points or null if no path
 */
export function findPathToCoord(roomMap, startC, startR, targetC, targetR, reservedTiles = null, excludeAgent = null) {
  const activeMap = getActiveRoomMap(roomMap)
  const queue = [{ c: startC, r: startR, path: [] }]
  const visited = new Set([`${startC},${startR}`])

  let iterations = 0
  const MAX_ITERATIONS = 5000 // Failsafe to prevent infinite loops and canvas freezes

  while (queue.length > 0) {
    iterations++
    if (iterations > MAX_ITERATIONS) {
      console.warn(`Pathfinding BFS exceeded max iterations (${MAX_ITERATIONS}) for ${excludeAgent}. Aborting to prevent freeze.`)
      return null
    }

    const curr = queue.shift()
    if (curr.c === targetC && curr.r === targetR) {
      return curr.path.map(p => ({
        x: p.c * TILE_SIZE + TILE_SIZE / 2,
        y: p.r * TILE_SIZE + TILE_SIZE / 2
      })).concat({
        x: targetC * TILE_SIZE + TILE_SIZE / 2,
        y: targetR * TILE_SIZE + TILE_SIZE / 2
      })
    }

    const neighbors = [
      { c: curr.c + 1, r: curr.r }, { c: curr.c - 1, r: curr.r },
      { c: curr.c, r: curr.r + 1 }, { c: curr.c, r: curr.r - 1 }
    ]

    for (let n of neighbors) {
      const key = `${n.c},${n.r}`
      if (!visited.has(key)) {
        let walkable = isWalkable(n.c, n.r, reservedTiles, excludeAgent, activeMap)
        
        // EXACT TARGET OVERRIDE: Allow stepping onto the target tile even if normally non-walkable (ex: Desk)
        if (!walkable && n.c === targetC && n.r === targetR) {
          // Verify it is within room bounds
          walkable = (n.c >= 0 && n.c < activeMap[0].length && n.r >= 0 && n.r < activeMap.length)
          // Verify it is not explicitly reserved by another agent
          if (walkable && reservedTiles) {
            const reserver = reservedTiles.get(key)
            if (reserver && reserver !== excludeAgent) {
              walkable = false
            }
          }
        }

        if (walkable) {
          visited.add(key)
          queue.push({ c: n.c, r: n.r, path: [...curr.path, { c: n.c, r: n.r }] })
        }
      }
    }
  }
  return null
}

/**
 * Find the nearest tile of a specific type
 * @param {Object} roomMap - The room map array
 * @param {{c: number, r: number}} pos - Current grid position
 * @param {number} tileType - Tile type to find
 * @returns {{c: number, r: number}|null} Nearest tile coordinates or null
 */
export function findNearestTile(roomMap, pos, tileType) {
  const activeMap = getActiveRoomMap(roomMap)
  const targetType = Number(tileType)
  let nearest = null
  let minDist = 9999

  for (let r = 0; r < activeMap.length; r++) {
    for (let c = 0; c < activeMap[0].length; c++) {
      if (Number(activeMap[r][c]) === targetType) {
        const d = Math.abs(pos.c - c) + Math.abs(pos.r - r)
        if (d < minDist) {
          minDist = d
          nearest = { c, r }
        }
      }
    }
  }
  return nearest
}

/**
 * Find the nearest walkable coordinate to a requested grid tile.
 * Expands outward in rings until a valid walkable tile is found.
 * @param {Object} roomMap - The room map array
 * @param {number} targetC - Requested column
 * @param {number} targetR - Requested row
 * @param {Map|null} reservedTiles - Optional map of reserved tiles
 * @param {string|null} excludeAgent - Agent ID to exclude from reservation check
 * @returns {{c: number, r: number}|null} Nearest walkable tile or null
 */
export function findNearestWalkableCoord(roomMap, targetC, targetR, reservedTiles = null, excludeAgent = null) {
  const activeMap = getActiveRoomMap(roomMap)
  if (!Array.isArray(activeMap) || activeMap.length === 0 || !Array.isArray(activeMap[0])) {
    return null
  }

  const height = activeMap.length
  const width = activeMap[0].length
  const maxRadius = Math.max(width, height)

  if (isWalkable(targetC, targetR, reservedTiles, excludeAgent, activeMap)) {
    return { c: targetC, r: targetR }
  }

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue
        const c = targetC + dc
        const r = targetR + dr
        if (c < 0 || c >= width || r < 0 || r >= height) continue
        if (isWalkable(c, r, reservedTiles, excludeAgent, activeMap)) {
          return { c, r }
        }
      }
    }
  }

  return null
}

/**
 * Find a random walkable tile
 * @returns {{c: number, r: number}|null} Random walkable tile or null
 */
export function findRandomWalkable(roomMap = null) {
  const activeMap = getActiveRoomMap(roomMap)
  const walkableTiles = []

  for (let r = 0; r < activeMap.length; r++) {
    for (let c = 0; c < activeMap[0].length; c++) {
      if (isWalkable(c, r, null, null, activeMap)) {
        walkableTiles.push({ c, r })
      }
    }
  }

  if (walkableTiles.length === 0) return null
  return walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
}
