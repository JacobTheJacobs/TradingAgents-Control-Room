import { TILE_TYPES, ROOM_MAP, TILE_SIZE } from '../../../../utils/constants'
import { isWalkable } from '../pathfinding'
import { MovePriority } from '../MovementManager'

export class ConsensusScene {
    constructor(scene) {
        this.scene = scene
    }

    /**
     * Gather agents around the consensus table
     */
    async gatherForConsensus(opinions) {
        console.log(`[ConsensusScene] Gathering for consensus`, opinions)

        // 1. Find the table tiles
        const tableTiles = []
        for (let r = 0; r < ROOM_MAP.length; r++) {
            for (let c = 0; c < ROOM_MAP[0].length; c++) {
                if (ROOM_MAP[r][c] === TILE_TYPES.TABLE) {
                    tableTiles.push({ r, c })
                }
            }
        }

        if (tableTiles.length === 0) return

        // 2. Find walkable tiles adjacent to the table
        const meetingSpots = []
        const visited = new Set()

        tableTiles.forEach(tile => {
            const neighbors = [
                { r: tile.r - 1, c: tile.c },
                { r: tile.r + 1, c: tile.c },
                { r: tile.r, c: tile.c - 1 },
                { r: tile.r, c: tile.c + 1 }
            ]

            neighbors.forEach(n => {
                const key = `${n.r},${n.c}`
                if (!visited.has(key) && isWalkable(n.c, n.r)) {
                    meetingSpots.push(n)
                    visited.add(key)
                }
            })
        })

        if (meetingSpots.length === 0) return

        // 3. Assign agents to meeting spots
        const agentNames = Object.keys(this.scene.agents)
        let spotIdx = 0

        agentNames.forEach(name => {
            const spot = meetingSpots[spotIdx % meetingSpots.length]
            spotIdx++

            // We don't have a direct "move to grid" in scene yet, 
            // but we can use startPathMovement if we calculate the path
            // For now, let's use the moveAgentToStation with a custom 'table' type
            // after ensuring STATION_TILE_MAP includes table.
            this.scene.moveAgentToStation(name, 'table', MovePriority.AUTOMATED, 'consensus:gather')

            // Override with talking animation once they arrive (or just play it)
            const agent = this.scene.agents[name]
            if (agent) {
                setTimeout(() => {
                    const key = `agent_${name.toLowerCase()}`
                    agent.play(`${key}_chat`, true)
                }, 3000) // Delay to let them walk there
            }
        })
    }

    /**
     * End consensus and return to normal behaviors
     */
    disperse() {
        Object.keys(this.scene.agents).forEach(name => {
            this.scene.moveAgentToStation(name, 'desk', MovePriority.AUTOMATED, 'consensus:disperse')
        })
    }
}

export const getConsensusScene = (scene) => {
    return new ConsensusScene(scene)
}
