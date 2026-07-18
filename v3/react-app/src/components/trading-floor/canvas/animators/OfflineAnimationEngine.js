import { ERROR_ANIMATIONS } from '../../../../utils/constants'

export class OfflineAnimationEngine {
    constructor(scene) {
        this.scene = scene
        this.isOffline = false
        this.overlay = null
    }

    /**
     * Enter offline/error mode
     */
    enterOfflineMode(reason) {
        console.log(`[OfflineAnimationEngine] Entering offline mode: ${reason}`)
        this.isOffline = true

        // Dim the scene
        if (!this.overlay) {
            this.overlay = this.scene.add.rectangle(0, 0, 1000, 1000, 0x000033, 0.3)
            this.overlay.setOrigin(0)
            this.overlay.setDepth(9998)
            this.overlay.setScrollFactor(0)
        } else {
            this.overlay.setVisible(true)
        }

        // Gray out agents removed
        Object.values(this.scene.agents).forEach(agent => {
            const key = `agent_${agent.agentName.toLowerCase()}`
            agent.play(`${key}_sleep`, true)
        })
    }

    /**
     * Exit offline mode
     */
    exitOfflineMode() {
        console.log(`[OfflineAnimationEngine] Exiting offline mode`)
        this.isOffline = false

        if (this.overlay) {
            this.overlay.setVisible(false)
        }

        // Restore agents
        Object.values(this.scene.agents).forEach(agent => {
            agent.clearTint()
            const key = `agent_${agent.agentName.toLowerCase()}`
            agent.play(`${key}_idle`, true)
        })
    }

    /**
     * Play a specific error animation on an agent
     */
    playErrorAnimation(agentName, errorType) {
        const agent = this.scene.agents[agentName]
        if (!agent) return

        const animName = ERROR_ANIMATIONS[errorType] || ERROR_ANIMATIONS['default']
        const key = `agent_${agentName.toLowerCase()}`

        agent.play(`${key}_${animName}`, true)

        // Restore idle after 5 seconds
        setTimeout(() => {
            if (!this.isOffline) {
                agent.play(`${key}_idle`, true)
            }
        }, 5000)
    }
}

export const getOfflineAnimationEngine = (scene) => {
    return new OfflineAnimationEngine(scene)
}
