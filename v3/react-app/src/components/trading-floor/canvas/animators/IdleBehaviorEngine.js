import { IDLE_BY_SCHEDULE, ANIMATION_DURATIONS, AGENT_STATIONS } from '../../../../utils/constants'
import { MovePriority } from '../MovementManager'

export class IdleBehaviorEngine {
  constructor(scene) {
    this.scene = scene
    this.activeAnimations = new Map() // agent -> animation info
    this.gossipEngine = null
    this.isRunning = false
    this.schedulePhase = 'pre_market'
  }

  /**
   * Start the idle behavior engine
   */
  start(schedulePhase = 'pre_market') {
    this.isRunning = true
    this.schedulePhase = schedulePhase
    this.runIdleLoop()
  }

  /**
   * Stop the idle behavior engine
   */
  stop() {
    this.isRunning = false
  }

  /**
   * Update schedule phase and trigger appropriate behaviors
   */
  setSchedulePhase(phase) {
    this.schedulePhase = phase
    this.applyPhaseBehavior()
  }

  /**
   * Main idle loop - randomly triggers idle animations
   */
  async runIdleLoop() {
    while (this.isRunning) {
      // Wait random interval between animations
      await this.delay(2000 + Math.random() * 5000)

      if (!this.isRunning || !this.scene || !this.scene.sys || !this.scene.sys.isActive()) {
        this.stop()
        break
      }

      // Pick random agent that's not already animating
      const availableAgents = this.getAvailableAgents()
      if (availableAgents.length === 0) continue

      const agent = availableAgents[Math.floor(Math.random() * availableAgents.length)]

      // Trigger idle animation
      await this.triggerIdleAnimation(agent)
    }
  }

  /**
   * Get agents not currently in an animation and not busy with higher-priority moves
   */
  getAvailableAgents() {
    if (this.scene.showrunner?.isManualRallyActive?.()) {
      return []
    }

    return Object.keys(this.scene.agents).filter(name => {
      // Skip agents in an idle animation
      if (this.activeAnimations.has(name)) return false
      // Skip agents that are busy with user or automated commands
      if (this.scene.movementManager?.isAgentBusy(name, MovePriority.AUTOMATED)) return false
      return true
    })
  }

  /**
   * Trigger an idle animation for an agent
   */
  async triggerIdleAnimation(agentName) {
    const animation = this.getRandomAnimationForPhase()
    const duration = this.getAnimationDuration(animation)

    // Mark agent as animating
    this.activeAnimations.set(agentName, { animation, startTime: Date.now() })

    // Play the animation
    await this.playAnimation(agentName, animation, duration)

    // Clear animation
    this.activeAnimations.delete(agentName)
  }

  /**
   * Get random animation for current schedule phase
   */
  getRandomAnimationForPhase() {
    const animations = IDLE_BY_SCHEDULE[this.schedulePhase] || IDLE_BY_SCHEDULE['midday']
    return animations[Math.floor(Math.random() * animations.length)]
  }

  /**
   * Get duration for animation (random within range)
   */
  getAnimationDuration(animationName) {
    const range = ANIMATION_DURATIONS[animationName] || ANIMATION_DURATIONS['default']
    return range[0] + Math.random() * (range[1] - range[0])
  }

  /**
   * Play an animation on an agent
   */
  async playAnimation(agentName, animationName, duration) {
    if (!this.isRunning || !this.scene || !this.scene.sys || !this.scene.sys.isActive()) return
    
    const agent = this.scene.agents[agentName]
    if (!agent || !agent.scene || !agent.anims || agent.active === false) return

    const key = `agent_${agentName.toLowerCase()}`

    // Map idle animation names to sprite animations
    const spriteAnim = this.mapToSpriteAnimation(animationName)

    // Play the animation
    try {
      if (spriteAnim) {
        agent.play(`${key}_${spriteAnim}`, true)
      }
    } catch (e) {
      console.warn(`Failed to play start animation for ${agentName}:`, e)
    }

    // Wait for duration
    await this.delay(duration)

    // Re-verify agent validity after delay
    if (!this.isRunning || !agent || !agent.scene || !agent.anims || agent.active === false) return

    // Reset to the agent's current base state (e.g. SIT_BACK at desk, IDLE otherwise)
    const baseAnim = this.scene.animController?.getBaseState(agentName) || 'idle'
    try {
      agent.play(`${key}_${baseAnim}`, true)
      if (agent.clearTint) agent.clearTint()
    } catch (e) {
      console.warn(`Failed to reset animation for ${agentName}:`, e)
    }
  }

  /**
   * Map idle animation names to sprite animations
   */
  mapToSpriteAnimation(idleAnim) {
    const mapping = {
      'sleep': 'idle',
      'nap_head_down': 'sit_back',
      'yawn': 'idle',
      'stretch': 'idle',
      'coffee_sip': 'drink',
      'coffee_refill': 'drink',
      'energy_drink': 'drink',
      'chin_scratch': 'idle',
      'head_scratch': 'idle',
      'glasses_adjust': 'idle',
      'glasses_clean': 'idle',
      'pen_tap': 'sit_back',
      'notebook_write': 'sit_back',
      'deep_thought': 'sit_back',
      'screen_stare': 'sit_back',
      'screen_lean': 'sit_back',
      'ticker_watch': 'sit_back',
      'multi_screen': 'sit_back',
      'eye_roll': 'idle',
      'facepalm': 'idle',
      'shrug': 'idle',
      'head_shake': 'idle',
      'thumbs_up': 'point',
      'fist_pump': 'cheer',
      'victory_pose': 'cheer',
      'phone_check': 'sit_back',
      'phone_text': 'sit_back',
      'phone_call': 'talk',
      'whisper': 'talk',
      'gossip': 'talk',
      'laugh': 'cheer',
      'nod_agree': 'idle',
      'argue': 'talk',
      'high_five': 'cheer',
      'handshake': 'talk',
      'pace': 'walk_side',
      'wander': 'walk_side',
      'pace_fast': 'walk_side',
      'spin_chair': 'idle',
      'lean_back_chair': 'sit_back',
      'snack': 'drink',
      'lunch': 'sit_back',
      'water_bottle': 'drink',
      'feet_up': 'sit_back',
      'headphones_on': 'sit_back',
      'head_bob': 'idle',
      'paper_shuffle': 'sit_back',
      'paper_read': 'sit_back',
      'file_away': 'sit_back',
      'check_watch': 'idle',
      'look_out_window': 'idle',
      'fix_tie': 'idle',
      'dust_off': 'idle',
      'stretch_arms': 'idle',
      'neck_crack': 'idle',
    }
    return mapping[idleAnim] || 'idle'
  }

  /**
   * Apply behavior for current schedule phase to all agents
   */
  applyPhaseBehavior() {
    if (this.scene.showrunner?.isManualRallyActive?.()) {
      return
    }

    const behaviors = {
      'pre_market': () => this.preMarketBehavior(),
      'open': () => this.openBehavior(),
      'midday': () => this.middayBehavior(),
      'power_hour': () => this.powerHourBehavior(),
      'after_hours': () => this.afterHoursBehavior(),
      'weekend': () => this.weekendBehavior(),
    }

    behaviors[this.schedulePhase]?.()
  }

  /**
   * Pre-Market behavior: Agents at desks, focused
   */
  async preMarketBehavior() {
    for (const [name, agent] of Object.entries(this.scene.agents)) {
      if (agent && agent.clearTint) agent.clearTint()
      const station = AGENT_STATIONS[name]?.station || 'desk'
      await this.scene.moveAgentToStation(name, station, MovePriority.IDLE, 'idle:preMarket')
    }
  }

  /**
   * Open behavior: Intense focus on screens
   */
  async openBehavior() {
    for (const [name, agent] of Object.entries(this.scene.agents)) {
      if (!agent || !agent.play) continue // Skip if agent sprite not ready
      if (agent.clearTint) agent.clearTint()
      const key = `agent_${name.toLowerCase()}`
      try {
        agent.play(`${key}_sit_back`, true) // Watching screens intently
      } catch {
        // Animation might not exist, ignore
      }
    }
  }

  /**
   * Midday behavior: Gossip mode, wander around
   */
  async middayBehavior() {
    // Move some agents to cooler for gossip
    const agentNames = Object.keys(this.scene.agents)
    const gossipCount = Math.min(4, Math.floor(agentNames.length / 3))

    for (let i = 0; i < gossipCount; i++) {
      const agent = agentNames[i]
      if (this.scene.agents[agent] && this.scene.agents[agent].clearTint) this.scene.agents[agent].clearTint()
      await this.scene.moveAgentToStation(agent, 'cooler', MovePriority.IDLE, 'idle:middayGossip')
    }

    // Others wander
    for (let i = gossipCount; i < agentNames.length; i++) {
      const agent = agentNames[i]
      if (this.scene.agents[agent] && this.scene.agents[agent].clearTint) this.scene.agents[agent].clearTint()
      // Random wandering handled by idle loop
    }
  }

  /**
   * Power Hour behavior: Focused execution
   */
  async powerHourBehavior() {
    for (const [name, agent] of Object.entries(this.scene.agents)) {
      if (agent && agent.clearTint) agent.clearTint()
      const key = `agent_${name.toLowerCase()}`
      agent.play(`${key}_sit_back`, true) // Fast typing
    }
  }

  /**
   * After Hours behavior: Half sleep, half research
   */
  async afterHoursBehavior() {
    const agentNames = Object.keys(this.scene.agents)
    const half = Math.floor(agentNames.length / 2)

    // Dim the room
    // this.scene.lights.setAmbient(0.5) // If lights available

    for (let i = 0; i < agentNames.length; i++) {
      const agent = this.scene.agents[agentNames[i]]
      const key = `agent_${agentNames[i].toLowerCase()}`

      if (i < half) {
        // Sleepers
        // agent.setTint(0x666666) removed
        agent.play(`${key}_idle`, true)
      } else {
        // Researchers - stay at desk
        if (agent.clearTint) agent.clearTint()
        await this.scene.moveAgentToStation(agentNames[i], 'desk', MovePriority.IDLE, 'idle:afterHours')
        agent.play(`${key}_sit_back`, true)
      }
    }
  }

  /**
   * Weekend behavior: Most agents sleeping
   */
  async weekendBehavior() {
    for (const [name, agent] of Object.entries(this.scene.agents)) {
      // agent.setTint(0x555555) removed
      const key = `agent_${name.toLowerCase()}`
      agent.play(`${key}_idle`, true)
    }
  }

  /**
   * Handle error state - trigger error animation
   */
  async playErrorAnimation(agentName, animationName = 'facepalm', duration = 3000) {
    const targetAgent = agentName || Object.keys(this.scene.agents)[Math.floor(Math.random() * Object.keys(this.scene.agents).length)]

    await this.playAnimation(targetAgent, animationName, duration)
  }

  /**
   * Trigger gossip event between two agents
   */
  async triggerGossipEvent(quote) {
    const availableAgents = this.getAvailableAgents()
    if (availableAgents.length < 2) return

    // Pick two agents
    const shuffled = availableAgents.sort(() => Math.random() - 0.5)
    const agent1 = shuffled[0]
    const agent2 = shuffled[1]

    // Move both to cooler
    await Promise.all([
      this.scene.moveAgentToStation(agent1, 'cooler', MovePriority.IDLE, 'idle:gossip'),
      this.scene.moveAgentToStation(agent2, 'cooler', MovePriority.IDLE, 'idle:gossip')
    ])

    // Show speech bubbles
    if (this.scene.showSpeechBubble) {
      const agentSprite1 = this.scene.agents[agent1]
      const agentSprite2 = this.scene.agents[agent2]

      // First agent speaks
      this.scene.showSpeechBubble(agentSprite1, quote, 3000)

      // Play talk animation
      const key1 = `agent_${agent1.toLowerCase()}`
      agentSprite1.play(`${key1}_talk`, true)

      await this.delay(3000)

      // Second agent responds
      const responses = [
        "Tell me about it...",
        "I know, right?!",
        "Classic...",
        "Unbelievable!",
        "That's wild!"
      ]
      const response = responses[Math.floor(Math.random() * responses.length)]
      this.scene.showSpeechBubble(agentSprite2, response, 2000)

      const key2 = `agent_${agent2.toLowerCase()}`
      agentSprite2.play(`${key2}_talk`, true)
    }
  }

  /**
   * Helper: Delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Singleton instance
let idleEngineInstance = null

export function getIdleBehaviorEngine(scene) {
  if (!idleEngineInstance && scene) {
    idleEngineInstance = new IdleBehaviorEngine(scene)
  } else if (idleEngineInstance && scene) {
    // Refresh scene reference in existing engine
    idleEngineInstance.scene = scene
  }
  return idleEngineInstance
}
