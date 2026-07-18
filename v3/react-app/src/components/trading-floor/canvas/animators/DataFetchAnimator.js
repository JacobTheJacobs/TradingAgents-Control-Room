import { AGENT_STATIONS, TOOL_STATIONS } from '../../../../utils/constants'
import { MovePriority } from '../MovementManager'

export class DataFetchAnimator {
    constructor(scene) {
        this.scene = scene
        this.activeAnimations = new Map()
    }

    /**
     * Start a data fetch animation sequence
     */
    async animateDataFetchStart(agentName, dataType, ticker) {
        console.log(`[DataFetchAnimator] ${agentName} fetching ${dataType} for ${ticker}`)

        // Determine station for this data type
        const station = TOOL_STATIONS[dataType] || 'desk'

        // Move agent to station
        this.scene.moveAgentToStation?.(agentName, station, MovePriority.AUTOMATED, 'dataFetch:start')

        // Play appropriate animation
        const agent = this.scene.agents[agentName]
        if (agent) {
            const key = `agent_${agentName.toLowerCase()}`
            let anim = 'sit_type'
            if (station === 'desk') anim = 'sit_back'
            else if (station === 'tv') anim = 'point'
            else if (station === 'cooler') anim = 'drink'

            agent.play(`${key}_${anim}`, true)

            this.activeAnimations.set(agentName, {
                type: dataType,
                ticker,
                anim
            })
        }
    }

    /**
     * Update progress for an active fetch
     */
    async animateDataFetchProgress(agentName, progress, stage) {
        console.log(`[DataFetchAnimator] ${agentName} progress: ${progress * 100}% - ${stage}`)
        // Future: Add progress bars above agent heads
    }

    /**
     * Complete the fetch animation
     */
    async animateDataFetchComplete(agentName, summary) {
        console.log(`[DataFetchAnimator] ${agentName} completed fetch: ${summary}`)
        this.activeAnimations.delete(agentName)

        // Move agent back home after a short delay
        setTimeout(() => {
            this.scene.moveAgentToStation?.(agentName, 'desk', MovePriority.AUTOMATED, 'dataFetch:complete')
        }, 2000)
    }

    /**
     * Error during fetch
     */
    async animateDataFetchError(agentName, error) {
        console.warn(`[DataFetchAnimator] ${agentName} fetch error: ${error}`)
        const agent = this.scene.agents[agentName]
        if (agent) {
            const key = `agent_${agentName.toLowerCase()}`
            agent.play(`${key}_facepalm`, true)
        }
        this.activeAnimations.delete(agentName)
    }
}

export const getDataFetchAnimator = (scene) => {
    return new DataFetchAnimator(scene)
}

export const PHASE_FETCH_ANIMATIONS = {
    'market_data': 'fetch_market',
    'sentiment': 'fetch_sentiment',
    'social': 'fetch_social'
}
