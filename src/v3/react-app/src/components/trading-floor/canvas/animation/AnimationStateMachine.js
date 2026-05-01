import { 
  AnimationState, 
  AnimStateType, 
  EmoteState, 
  TransitionState,
  MovementState,
  IdleState 
} from './AnimationState'

// Re-export for convenience
export { 
  AnimationState, 
  AnimStateType, 
  EmoteState, 
  TransitionState,
  MovementState,
  IdleState 
}

/**
 * State Machine for managing animation states with proper transitions.
 * Implements the state pattern with centralized state management.
 */
export class AnimationStateMachine {
  constructor(context = {}) {
    this.context = context
    this.states = new Map()
    this.currentState = null
    this.previousState = null
    this.stateHistory = []
    this.maxHistorySize = 10
    this.defaultStateType = AnimStateType.IDLE
    
    // Transition graph: fromState -> [{ toState, condition, weight }]
    this.transitionGraph = new Map()
    
    // Weighted transitions for random idle behaviors
    this.weightedTransitions = new Map()
    
    // Event listeners
    this.listeners = new Map()
    
    // Register default states
    this.registerDefaultStates()
  }
  
  /**
   * Register all default animation states
   */
  registerDefaultStates() {
    // Core movement states
    Object.values(AnimStateType).forEach(stateType => {
      this.registerState(new AnimationState({ stateType }))
    })
    
    // Emote states with auto-return
    const emotes = [
      { stateType: AnimStateType.CHEER, duration: 2000, canInterrupt: false },
      { stateType: AnimStateType.LOSE, duration: 2000, canInterrupt: false },
      { stateType: AnimStateType.YAWN, duration: 1500, canInterrupt: true },
      { stateType: AnimStateType.FACEPALM, duration: 1500, canInterrupt: true },
      { stateType: AnimStateType.ARGUE, duration: 3000, canInterrupt: false },
      { stateType: AnimStateType.STRETCH, duration: 1500, canInterrupt: true }
    ]
    
    emotes.forEach(config => {
      this.registerState(new EmoteState(config))
    })
    
    // Transition states
    const transitions = [
      { stateType: AnimStateType.STAND_UP, duration: 300, targetState: AnimStateType.IDLE },
      { stateType: AnimStateType.SIT_DOWN, duration: 300, targetState: AnimStateType.SIT_TYPE },
      { stateType: AnimStateType.TURN_LEFT, duration: 200, targetState: null },
      { stateType: AnimStateType.TURN_RIGHT, duration: 200, targetState: null }
    ]
    
    transitions.forEach(config => {
      this.registerState(new TransitionState(config))
    })
    
    // Set initial state to Idle
    this.currentState = this.getState(AnimStateType.IDLE)
    if (this.currentState) {
      this.currentState.enter(this.context)
    }
  }
  
  /**
   * Register a state
   * @param {AnimationState} state - The state to register
   */
  registerState(state) {
    this.states.set(state.stateType, state)
  }
  
  /**
   * Get state by type
   * @param {string} stateType - The state type to look up
   * @returns {AnimationState} The state or default idle state
   */
  getState(stateType) {
    return this.states.get(stateType) || this.states.get(this.defaultStateType) || this.states.get(AnimStateType.IDLE)
  }

  /**
   * Set the default state type for this machine.
   * @param {string} stateType - AnimStateType
   */
  setDefaultState(stateType) {
    if (this.states.has(stateType)) {
      this.defaultStateType = stateType
    }
  }
  
  /**
   * Attempt to transition to a new state
   * @param {string} newStateType - The target state type
   * @param {boolean} force - Force transition regardless of canInterrupt
   * @returns {boolean} True if transition succeeded
   */
  tryTransitionTo(newStateType, force = false) {
    // Same state, no transition needed
    if (newStateType === this.currentState?.stateType) {
      return false
    }
    
    const newState = this.getState(newStateType)
    if (!newState) {
      console.warn(`AnimationStateMachine: State "${newStateType}" not found`)
      return false
    }
    
    // Check if current state can be interrupted
    if (!force && this.currentState && !this.currentState.canInterrupt) {
      // Check if duration has elapsed for non-interruptible states
      if (this.currentState.duration && 
          this.currentState.stateTimer < this.currentState.duration / 1000) {
        return false
      }
    }
    
    // Perform transition
    const oldStateType = this.currentState?.stateType
    this.previousState = this.currentState
    
    // Exit current state
    if (this.currentState) {
      this.currentState.exit(this.context)
    }
    
    // Enter new state
    this.currentState = newState
    this.currentState.enter(this.context)
    
    // Update history
    if (oldStateType) {
      this.stateHistory.push(oldStateType)
      if (this.stateHistory.length > this.maxHistorySize) {
        this.stateHistory.shift()
      }
    }
    
    // Emit state change event
    this.emit('stateChanged', { 
      from: oldStateType, 
      to: newStateType,
      timestamp: Date.now()
    })
    
    return true
  }
  
  /**
   * Force a state transition regardless of canInterrupt
   * @param {string} newStateType - The target state type
   * @returns {boolean} True if transition succeeded
   */
  forceState(newStateType) {
    return this.tryTransitionTo(newStateType, true)
  }
  
  /**
   * Update the state machine
   * @param {number} deltaTime - Time since last update in seconds
   */
  update(deltaTime) {
    if (!this.currentState) return
    
    // Update current state
    this.currentState.update(deltaTime, this.context)
    
    // Check for automatic transitions
    const transitionTo = this.currentState.checkTransition(this.context)
    if (transitionTo) {
      this.tryTransitionTo(transitionTo)
    }
  }
  
  /**
   * Add a transition rule
   * @param {string} fromState - Source state type
   * @param {string} toState - Target state type
   * @param {Function|null} condition - Optional condition function
   * @param {number} weight - Weight for random selection
   */
  addTransition(fromState, toState, condition = null, weight = 1) {
    if (!this.transitionGraph.has(fromState)) {
      this.transitionGraph.set(fromState, [])
    }
    this.transitionGraph.get(fromState).push({ toState, condition, weight })
  }
  
  /**
   * Add weighted transition for random selection
   * @param {string} fromState - Source state type
   * @param {string} toState - Target state type
   * @param {number} weight - Relative weight
   */
  addWeightedTransition(fromState, toState, weight) {
    if (!this.weightedTransitions.has(fromState)) {
      this.weightedTransitions.set(fromState, [])
    }
    this.weightedTransitions.get(fromState).push({ state: toState, weight })
  }
  
  /**
   * Get weighted random next state
   * @returns {string|null} Next state type or null
   */
  getWeightedNextState() {
    const transitions = this.weightedTransitions.get(this.currentState?.stateType)
    if (!transitions || transitions.length === 0) return null
    
    const totalWeight = transitions.reduce((sum, t) => sum + t.weight, 0)
    let roll = Math.random() * totalWeight
    
    for (const { state, weight } of transitions) {
      roll -= weight
      if (roll <= 0) return state
    }
    
    return transitions[0].state
  }
  
  /**
   * Try weighted random transition
   * @returns {boolean} True if transitioned
   */
  tryWeightedTransition() {
    const nextState = this.getWeightedNextState()
    if (nextState) {
      return this.tryTransitionTo(nextState)
    }
    return false
  }
  
  /**
   * Check if currently in a specific state
   * @param {string} stateType - State type to check
   * @returns {boolean}
   */
  isInState(stateType) {
    return this.currentState?.stateType === stateType
  }
  
  /**
   * Check if current state is stationary
   * @returns {boolean}
   */
  isStationary() {
    const stationaryStates = [
      AnimStateType.SIT_TYPE,
      AnimStateType.SIT_BACK,
      AnimStateType.READ,
      AnimStateType.DRINK,
      AnimStateType.YAWN,
      AnimStateType.FACEPALM
    ]
    return stationaryStates.includes(this.currentState?.stateType)
  }
  
  /**
   * Check if current state is a movement state
   * @returns {boolean}
   */
  isMoving() {
    const movementStates = [
      AnimStateType.WALK_DOWN,
      AnimStateType.WALK_SIDE,
      AnimStateType.WALK_UP
    ]
    return movementStates.includes(this.currentState?.stateType)
  }
  
  /**
   * Check if current state is an emote state
   * @returns {boolean}
   */
  isEmoting() {
    const emoteStates = [
      AnimStateType.CHEER,
      AnimStateType.LOSE,
      AnimStateType.YAWN,
      AnimStateType.FACEPALM,
      AnimStateType.ARGUE,
      AnimStateType.STRETCH
    ]
    return emoteStates.includes(this.currentState?.stateType)
  }
  
  /**
   * Get current state type
   * @returns {string}
   */
  get currentStateType() {
    return this.currentState?.stateType || AnimStateType.IDLE
  }
  
  /**
   * Get previous state type
   * @returns {string}
   */
  get previousStateType() {
    return this.previousState?.stateType || AnimStateType.IDLE
  }
  
  /**
   * Get time in current state
   * @returns {number} Time in seconds
   */
  get timeInCurrentState() {
    return this.currentState?.stateTimer || 0
  }
  
  /**
   * Get state history for debugging
   * @returns {string[]}
   */
  getStateHistory() {
    return [...this.stateHistory]
  }
  
  /**
   * Reset to initial state
   */
  reset() {
    if (this.currentState) {
      this.currentState.exit(this.context)
    }
    this.currentState = this.getState(AnimStateType.IDLE)
    if (this.currentState) {
      this.currentState.enter(this.context)
    }
    this.stateHistory = []
    this.emit('reset', { timestamp: Date.now() })
  }
  
  // ==================== Event Handling ====================
  
  /**
   * Subscribe to state machine events
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push(callback)
    
    // Return unsubscribe function
    return () => this.off(event, callback)
  }
  
  /**
   * Unsubscribe from events
   * @param {string} event - Event name
   * @param {Function} callback - Callback to remove
   */
  off(event, callback) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      const idx = callbacks.indexOf(callback)
      if (idx >= 0) callbacks.splice(idx, 1)
    }
  }
  
  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.forEach(cb => {
        try {
          cb(data)
        } catch (err) {
          console.error(`AnimationStateMachine: Error in "${event}" handler:`, err)
        }
      })
    }
  }
  
  /**
   * Dispose of the state machine
   */
  dispose() {
    if (this.currentState) {
      this.currentState.exit(this.context)
    }
    this.states.clear()
    this.transitionGraph.clear()
    this.weightedTransitions.clear()
    this.listeners.clear()
    this.stateHistory = []
  }
}
