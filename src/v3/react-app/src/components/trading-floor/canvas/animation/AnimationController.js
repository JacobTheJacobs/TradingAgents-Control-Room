import { AnimationStateMachine, AnimStateType } from './AnimationStateMachine'
import { EventRouter } from './EventRouter'
import { ResourcePool } from './ResourcePool'

/**
 * Animation Controller - Simplified for 16-bit pixel art style
 * 
 * CHANGES FROM ORIGINAL:
 * - Removed BlendEngine (cross-fade muddies pixel art)
 * - Snappy, immediate frame swaps instead of blending
 * - Neutral frame reset before transitions (prevents stuck poses)
 * - Priority queue retained for animation sequencing
 * 
 * Features:
 * - Snappy state transitions (pixel-art friendly)
 * - Priority-based animation queue
 * - Event-driven animation triggering
 * - Proper cleanup and resource management
 */
export class AnimationController {
  constructor(scene, config = {}) {
    this.scene = scene
    this.config = {
      maxConcurrentAnimations: config.maxConcurrentAnimations || 50,
      queueSize: config.queueSize || 100,
      enableGapFilling: config.enableGapFilling !== false,
      debug: config.debug || false,
      ...config
    }
    
    // Core systems
    this.stateMachines = new Map() // spriteName -> AnimationStateMachine
    this.eventRouter = new EventRouter()
    this.resourcePool = new ResourcePool(scene)
    
    // Animation queues per sprite
    this.queues = new Map() // spriteName -> PriorityQueue[]
    
    // Transition definitions: "from->to" -> transitionAnim
    this.transitions = new Map()
    
    // Gap-filling transition map: fromState -> fillerAnim
    this.gapFillers = new Map()
    
    // Active sprites registry
    this.sprites = new Map() // spriteName -> { sprite, currentState, lastUpdate, isTransitioning }
    
    // Global state
    this.isPaused = false
    this.timeScale = 1.0
    
    // Statistics
    this.stats = {
      animationsPlayed: 0,
      transitionsCompleted: 0,
      gapFillersPlayed: 0,
      eventsEmitted: 0
    }

    // Base/Default states per sprite (e.g. SIT_BACK instead of IDLE)
    this.baseStates = new Map() // spriteName -> AnimStateType
    
    // Initialize default transitions
    this.initDefaultTransitions()
    this.initGapFillers()
  }
  
  /**
   * Initialize default transition definitions
   */
  initDefaultTransitions() {
    // Define which animations should play a transition before switching
    // NOTE: SIT_DOWN and STAND_UP transitions are disabled because those animations don't exist
    // in the sprite sheets. The transitions would cause errors.
    // To re-enable, add sit_down and stand_up animations to agentAnimations.js
    const transitions = [
      // From sitting to standing - DISABLED (no stand_up animation)
      // { from: AnimStateType.SIT_TYPE, to: AnimStateType.IDLE, transition: AnimStateType.STAND_UP },
      // { from: AnimStateType.SIT_BACK, to: AnimStateType.IDLE, transition: AnimStateType.STAND_UP },
      
      // From standing to sitting - DISABLED (no sit_down animation)
      // { from: AnimStateType.IDLE, to: AnimStateType.SIT_TYPE, transition: AnimStateType.SIT_DOWN },
      // { from: AnimStateType.IDLE, to: AnimStateType.SIT_BACK, transition: AnimStateType.SIT_DOWN }
    ]
    
    transitions.forEach(({ from, to, transition }) => {
      this.transitions.set(`${from}->${to}`, transition)
    })
  }
  
  /**
   * Initialize gap-filling animations
   * These play when an animation is interrupted mid-playback
   */
  initGapFillers() {
    // Gap-fillers provide smooth return to neutral state
    const fillers = [
      // Interrupted movement
      { from: AnimStateType.WALK_DOWN, filler: AnimStateType.IDLE },
      { from: AnimStateType.WALK_SIDE, filler: AnimStateType.IDLE },
      { from: AnimStateType.WALK_UP, filler: AnimStateType.IDLE },
      
      // Interrupted actions
      { from: AnimStateType.TALK, filler: AnimStateType.IDLE },
      { from: AnimStateType.POINT, filler: AnimStateType.IDLE },
      { from: AnimStateType.DRINK, filler: AnimStateType.IDLE },
      { from: AnimStateType.READ, filler: AnimStateType.IDLE },
      
      // Interrupted emotes
      { from: AnimStateType.CHEER, filler: AnimStateType.IDLE },
      { from: AnimStateType.LOSE, filler: AnimStateType.IDLE },
      { from: AnimStateType.ARGUE, filler: AnimStateType.IDLE }
    ]
    
    fillers.forEach(({ from, filler }) => {
      this.gapFillers.set(from, filler)
    })
  }
  
  // ==================== Registration ====================
  
  /**
   * Register a sprite for animation management
   * @param {string} name - Unique identifier for the sprite
   * @param {Phaser.GameObjects.Sprite} sprite - The Phaser sprite
   * @param {string} initialState - Initial animation state
   */
  register(name, sprite, initialState = AnimStateType.IDLE) {
    if (this.sprites.has(name)) {
      if (this.config.debug) {
        console.warn(`AnimationController: Sprite "${name}" already registered`)
      }
      return
    }
    
    // Create state machine for this sprite
    const stateMachine = new AnimationStateMachine({ sprite, controller: this })
    this.stateMachines.set(name, stateMachine)
    
    // Create priority queue
    this.queues.set(name, [])
    
    // Initialize base state
    this.baseStates.set(name, initialState)

    // Register sprite
    this.sprites.set(name, {
      sprite,
      currentState: initialState,
      lastUpdate: Date.now(),
      isTransitioning: false
    })
    
    // Register with resource pool
    this.resourcePool.register(name, sprite)
    
    // Set initial state
    stateMachine.forceState(initialState)
    
    if (this.config.debug) {
      console.log(`AnimationController: Registered "${name}" with state "${initialState}"`)
    }
  }
  
  /**
   * Unregister a sprite
   * @param {string} name - Sprite identifier
   */
  unregister(name) {
    this.resourcePool.release(name)
    this.sprites.delete(name)
    this.stateMachines.delete(name)
    this.queues.delete(name)
    this.baseStates.delete(name)
  }
  
  /**
   * Check if a sprite is registered
   * @param {string} name - Sprite identifier
   * @returns {boolean}
   */
  isRegistered(name) {
    return this.sprites.has(name)
  }

  /**
   * Set the base (default) state for a sprite.
   * This is what the sprite returns to after an animation finishes.
   * @param {string} name - Sprite identifier
   * @param {string} stateType - AnimStateType
   */
  setBaseState(name, stateType) {
    if (!this.sprites.has(name)) return
    this.baseStates.set(name, stateType)
    
    // Also update the state machine's default if it exists
    const sm = this.stateMachines.get(name)
    if (sm && typeof sm.setDefaultState === 'function') {
      sm.setDefaultState(stateType)
    }

    if (this.config.debug) {
      console.log(`AnimationController: Base state for "${name}" set to "${stateType}"`)
    }
  }

  /**
   * Get the current base (default) state for a sprite.
   * @param {string} name - Sprite identifier
   * @returns {string} AnimStateType
   */
  getBaseState(name) {
    return this.baseStates.get(name) || AnimStateType.IDLE
  }
  
  // ==================== Animation Playback ====================
  
  /**
   * Play an animation with snappy transitions (no blending)
   * @param {string} spriteName - Sprite identifier
   * @param {string} animKey - Animation key to play
   * @param {Object} options - Playback options
   * @returns {boolean} True if animation started
   */
  play(spriteName, animKey, options = {}) {
    try {
      const {
        priority = 0,
        interrupt = true,
        force = false,
        onComplete = null,
        skipGapFiller = false
      } = options
      
      const data = this.sprites.get(spriteName)
      if (!data) {
        if (this.config.debug) {
          console.warn(`AnimationController: Sprite "${spriteName}" not registered`)
        }
        return false
      }
      
      const stateMachine = this.stateMachines.get(spriteName)
      
      // Check if we need gap-filling transition
      if (this.config.enableGapFilling && !skipGapFiller && !data.isTransitioning) {
        const gapFiller = this.getGapFiller(data.currentState, animKey)
        if (gapFiller) {
          return this.playWithGapFiller(spriteName, gapFiller, animKey, options)
        }
      }
      
      // Check for defined transition
      const transitionKey = `${data.currentState}->${animKey}`
      const transitionAnim = this.transitions.get(transitionKey)
      
      if (transitionAnim && !force) {
        return this.playWithTransition(spriteName, transitionAnim, animKey, options)
      }
      
      // Direct transition - SNAPPY, no blend
      if (stateMachine.tryTransitionTo(animKey, force || interrupt)) {
        this.playAnimationDirect(spriteName, animKey, onComplete)
        return true
      }
      
      // Queue if we can't interrupt
      if (!interrupt) {
        this.enqueue(spriteName, animKey, priority, options)
        return false
      }
      
      return false
    } catch (err) {
      console.error(`[AnimationController] play error for "${spriteName}":`, err)
      if (options.onComplete) {
        try {
          options.onComplete()
        } catch (err2) {
          console.error(`[AnimationController] onComplete error after play failure for "${spriteName}":`, err2)
        }
      }
      return false
    }
  }
  
  /**
   * Play animation directly - SNAPPY frame swap
   * @param {string} spriteName - Sprite identifier
   * @param {string} animKey - Animation key
   * @param {Function} onComplete - Completion callback
   */
  playAnimationDirect(spriteName, animKey, onComplete) {
    try {
      const data = this.sprites.get(spriteName)
      if (!data) {
        console.warn(`[AnimationController] playAnimationDirect: Sprite "${spriteName}" not registered`)
        console.log('[AnimationController] Registered sprites:', [...this.sprites.keys()])
        if (onComplete) onComplete()
        return
      }
      
      let resolvedAnimKey = animKey
      let animKeyFull = this.getFullAnimKey(spriteName, resolvedAnimKey)
      console.log(`[AnimationController] Playing animation: ${animKeyFull} for sprite "${spriteName}"`)
      
      // Check if animation exists
      let animExists = this.scene.anims.exists(animKeyFull)
      if (!animExists) {
        const fallbackAnimKey = this.getFallbackAnimKey(spriteName, resolvedAnimKey)
        if (fallbackAnimKey) {
          resolvedAnimKey = fallbackAnimKey
          animKeyFull = this.getFullAnimKey(spriteName, resolvedAnimKey)
          animExists = this.scene.anims.exists(animKeyFull)
          console.warn(`[AnimationController] Missing "${animKey}" for "${spriteName}", falling back to "${resolvedAnimKey}"`)
        }
      }
      if (!animExists) {
        console.warn(`[AnimationController] Animation "${animKeyFull}" does not exist!`)
        if (this.scene.anims.getNames) {
          console.log('[AnimationController] Available animations:', 
            this.scene.anims.getNames().filter(k => k.includes(spriteName.toLowerCase().split(' ')[0])))
        }
      }
      
      this.stats.animationsPlayed++
      
      // NEUTRAL FRAME RESET - prevents stuck poses
      // Stop current animation and reset to first frame
      if (data.sprite.anims) {
        data.sprite.stop()
        data.sprite.setFrame(0)
      }
      
      // SNAPPY: Play immediately, no alpha blending
      if (animKeyFull && data.sprite.anims && animExists) {
        data.sprite.play(animKeyFull, true)
        console.log(`[AnimationController] ✅ Successfully playing: ${animKeyFull}`)
      } else {
        console.error(`[AnimationController] ❌ Failed to play: ${animKeyFull}`)
      }
      
      data.currentState = resolvedAnimKey
      data.isTransitioning = false
      data.lastUpdate = Date.now()
      this.stats.transitionsCompleted++
      
      if (onComplete) {
        try {
          onComplete()
        } catch (err) {
          console.error(`AnimationController: onComplete error for "${spriteName}":`, err)
        }
      }
      
      // Process queue after a short delay to allow animation to play
      this.scene.time.delayedCall(50, () => {
        this.processQueue(spriteName)
      })
    } catch (err) {
      console.error(`[AnimationController] playAnimationDirect error for "${spriteName}":`, err)
      // Always call onComplete even if there was an error, to prevent freezing
      if (onComplete) {
        try {
          onComplete()
        } catch (err2) {
          console.error(`AnimationController: onComplete error after failure for "${spriteName}":`, err2)
        }
      }
    }
  }
  
  /**
   * Play with gap-filling transition
   * @param {string} spriteName - Sprite identifier
   * @param {string} gapFiller - Gap-filler animation
   * @param {string} targetAnim - Target animation
   * @param {Object} options - Playback options
   * @returns {boolean}
   */
  playWithGapFiller(spriteName, gapFiller, targetAnim, options) {
    const data = this.sprites.get(spriteName)
    if (!data) return false
    
    this.stats.gapFillersPlayed++
    
    if (this.config.debug) {
      console.log(`AnimationController: Playing gap-filler "${gapFiller}" for "${spriteName}"`)
    }
    
    // Play gap-filler first (snappy)
    this.playAnimationDirect(spriteName, gapFiller, () => {
      // Then play target with skipGapFiller to avoid recursion
      this.play(spriteName, targetAnim, { ...options, force: true, skipGapFiller: true })
    })
    
    return true
  }
  
  /**
   * Play with defined transition animation
   * @param {string} spriteName - Sprite identifier
   * @param {string} transitionAnim - Transition animation
   * @param {string} targetAnim - Target animation
   * @param {Object} options - Playback options
   * @returns {boolean}
   */
  playWithTransition(spriteName, transitionAnim, targetAnim, options) {
    const data = this.sprites.get(spriteName)
    if (!data) return false
    
    data.isTransitioning = true
    
    // Play transition animation (snappy)
    this.playAnimationDirect(spriteName, transitionAnim, () => {
      // Then play target
      this.play(spriteName, targetAnim, { ...options, force: true })
    })
    
    return true
  }
  
  /**
   * Get gap-filler animation for interrupted state
   * @param {string} fromState - Current state
   * @param {string} toState - Target state
   * @returns {string|null} Gap-filler animation or null
   */
  getGapFiller(fromState, toState) {
    // Only use gap-filler if significantly different states
    const isSignificantChange = 
      (fromState?.includes('sit') && !toState?.includes('sit')) ||
      (fromState?.includes('walk') && !toState?.includes('walk')) ||
      (this.isEmoteState(fromState) && !this.isEmoteState(toState))
    
    if (!isSignificantChange) return null
    
    return this.gapFillers.get(fromState) || null
  }
  
  /**
   * Check if state is an emote
   * @param {string} state - State to check
   * @returns {boolean}
   */
  isEmoteState(state) {
    const emoteStates = [
      AnimStateType.CHEER,
      AnimStateType.LOSE,
      AnimStateType.ARGUE,
      AnimStateType.YAWN,
      AnimStateType.STRETCH,
      AnimStateType.FACEPALM
    ]
    return emoteStates.includes(state)
  }
  
  /**
   * Get full animation key for Phaser
   * @param {string} spriteName - Sprite name
   * @param {string} animKey - Animation key
   * @returns {string} Full animation key
   */
  getFullAnimKey(spriteName, animKey) {
    // Handle both "agent_warren_idle" and "idle" formats
    if (animKey?.includes(spriteName.toLowerCase())) {
      return animKey
    }
    return `agent_${spriteName.toLowerCase()}_${animKey}`
  }

  /**
   * Resolve a safe fallback animation when a requested emote is not implemented.
   * This keeps scene playback moving instead of failing on one missing sprite strip.
   * @param {string} spriteName
   * @param {string} animKey
   * @returns {string|null}
   */
  getFallbackAnimKey(spriteName, animKey) {
    const fallbackMap = {
      [AnimStateType.LOSE]: [AnimStateType.FACEPALM, AnimStateType.WHINE, AnimStateType.IDLE],
      [AnimStateType.ARGUE]: [AnimStateType.TALK, AnimStateType.POINT, AnimStateType.IDLE],
      [AnimStateType.YAWN]: [AnimStateType.IDLE],
      [AnimStateType.STRETCH]: [AnimStateType.IDLE],
    }

    const candidates = fallbackMap[animKey] || [AnimStateType.IDLE]
    for (const candidate of candidates) {
      const candidateKey = this.getFullAnimKey(spriteName, candidate)
      if (this.scene.anims.exists(candidateKey)) {
        return candidate
      }
    }
    return null
  }
  
  // ==================== Queue Management ====================
  
  /**
   * Add to animation queue
   * @param {string} spriteName - Sprite identifier
   * @param {string} animKey - Animation key
   * @param {number} priority - Priority (higher = first)
   * @param {Object} options - Playback options
   */
  enqueue(spriteName, animKey, priority, options) {
    const queue = this.queues.get(spriteName)
    if (!queue) return
    
    if (queue.length >= this.config.queueSize) {
      // Remove lowest priority item
      queue.sort((a, b) => b.priority - a.priority)
      queue.pop()
    }
    
    queue.push({ animKey, priority, options, timestamp: Date.now() })
    queue.sort((a, b) => b.priority - a.priority)
  }
  
  /**
   * Process queued animations for a sprite
   * @param {string} spriteName - Sprite identifier
   */
  processQueue(spriteName) {
    const queue = this.queues.get(spriteName)
    if (!queue || queue.length === 0) return
    
    const next = queue.shift()
    this.play(spriteName, next.animKey, next.options)
  }
  
  /**
   * Clear animation queue for sprite
   * @param {string} spriteName - Sprite identifier
   */
  clearQueue(spriteName) {
    const queue = this.queues.get(spriteName)
    if (queue) {
      queue.length = 0
    }
  }
  
  /**
   * Get queue size for sprite
   * @param {string} spriteName - Sprite identifier
   * @returns {number}
   */
  getQueueSize(spriteName) {
    const queue = this.queues.get(spriteName)
    return queue ? queue.length : 0
  }
  
  // ==================== Reset & Cleanup ====================
  
  /**
   * Reset sprite to initial/idle state
   * @param {string} spriteName - Sprite identifier
   * @param {string} targetState - Target state (default: idle)
   */
  reset(spriteName, targetState = null) {
    const data = this.sprites.get(spriteName)
    if (!data) return
    
    // Default to the current base state if no specific target state provided
    if (targetState === null) {
      targetState = this.getBaseState(spriteName)
    }
    
    // Clear queue
    this.clearQueue(spriteName)
    
    // Force transition to target state
    const stateMachine = this.stateMachines.get(spriteName)
    if (stateMachine) {
      stateMachine.forceState(targetState)
    }
    
    // Play directly (snappy)
    this.playAnimationDirect(spriteName, targetState, null)
    
    data.isTransitioning = false
  }
  
  /**
   * Reset all sprites to idle
   */
  resetAll() {
    for (const spriteName of this.sprites.keys()) {
      this.reset(spriteName)
    }
  }
  
  /**
   * Pause all animations
   */
  pause() {
    this.isPaused = true
    for (const [, data] of this.sprites) {
      if (data.sprite.anims) {
        data.sprite.anims.pause()
      }
    }
  }
  
  /**
   * Resume all animations
   */
  resume() {
    this.isPaused = false
    for (const [, data] of this.sprites) {
      if (data.sprite.anims) {
        data.sprite.anims.resume()
      }
    }
  }
  
  // ==================== Event System ====================
  
  /**
   * Subscribe to animation events
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    return this.eventRouter.on(event, callback)
  }
  
  /**
   * Unsubscribe from events
   * @param {string} event - Event name
   * @param {Function} callback - Callback to remove
   */
  off(event, callback) {
    this.eventRouter.off(event, callback)
  }
  
  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    this.stats.eventsEmitted++
    this.eventRouter.emit(event, data)
  }
  
  /**
   * Trigger animation by event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  onEvent(event, data) {
    this.eventRouter.handleEvent(event, data)
  }
  
  /**
   * Map an event to an animation
   * @param {string} eventName - Event name
   * @param {string} animationKey - Animation key
   */
  mapEventToAnimation(eventName, animationKey) {
    this.eventRouter.mapEventToAnimation(eventName, animationKey)
  }
  
  // ==================== Update Loop ====================
  
  /**
   * Main update - called every frame
   * @param {number} deltaTime - Time since last update in seconds
   */
  update(deltaTime) {
    if (this.isPaused) return
    
    const scaledDelta = deltaTime * this.timeScale
    
    // Update all state machines
    for (const [, stateMachine] of this.stateMachines) {
      stateMachine.update(scaledDelta)
    }
    
    // Update resource pool (periodic cleanup)
    this.resourcePool.update(scaledDelta)
  }
  
  // ==================== Stats & Debug ====================
  
  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    const resourceStats = this.resourcePool.getStats()
    return {
      ...this.stats,
      ...resourceStats,
      registeredSprites: this.sprites.size,
      isPaused: this.isPaused,
      timeScale: this.timeScale
    }
  }
  
  /**
   * Get current state for sprite
   * @param {string} spriteName - Sprite identifier
   * @returns {string|null}
   */
  getCurrentState(spriteName) {
    const data = this.sprites.get(spriteName)
    return data ? data.currentState : null
  }
  
  /**
   * Check if sprite is transitioning
   * @param {string} spriteName - Sprite identifier
   * @returns {boolean}
   */
  isTransitioning(spriteName) {
    const data = this.sprites.get(spriteName)
    return data ? data.isTransitioning : false
  }
  
  // ==================== Cleanup ====================
  
  /**
   * Dispose of all resources
   */
  dispose() {
    // Clear all sprites
    for (const spriteName of this.sprites.keys()) {
      this.unregister(spriteName)
    }
    
    // Dispose systems
    this.resourcePool.dispose()
    this.eventRouter.dispose()
    
    // Clear maps
    this.stateMachines.clear()
    this.queues.clear()
    this.sprites.clear()
    this.transitions.clear()
    this.gapFillers.clear()
  }
}
