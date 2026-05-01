/**
 * Animation State Types - Maps to sprite animations
 */
export const AnimStateType = {
  // Movement
  IDLE: 'idle',
  WALK_DOWN: 'walk_down',
  WALK_SIDE: 'walk_side',
  WALK_UP: 'walk_up',
  
  // Actions
  TALK: 'talk',
  POINT: 'point',
  DRINK: 'drink',
  READ: 'read',
  SIT_TYPE: 'sit_type',
  SIT_BACK: 'sit_back',
  
  // Emotes
  CHEER: 'cheer',
  LOSE: 'lose',
  ARGUE: 'argue',
  YAWN: 'yawn',
  STRETCH: 'stretch',
  FACEPALM: 'facepalm',
  WHINE: 'whine',
  BUY: 'buy',
  SELL: 'sell',
  HODL: 'hodl',
  MOON: 'moon',
  REKT: 'rekt',
  BAGHOLDER: 'bagholder',
  COPIUM: 'copium',
  RUGPULL: 'rugpull',
  LAMBO: 'lambo',
  BRRR: 'brrr',
  BULLTRAP: 'bulltrap',
  DEADCAT: 'deadcat',
  MELT: 'melt',
  BUYDIP: 'buydip',
  ROCKET: 'rocket',
  FATFINGER: 'fatfinger',
  LEVERAGE: 'leverage',
  TENDIES: 'tendies',
  WHALE: 'whale',
  FED: 'fed',
  
  // Transitions (gap-filling)
  STAND_UP: 'stand_up',
  SIT_DOWN: 'sit_down',
  TURN_LEFT: 'turn_left',
  TURN_RIGHT: 'turn_right',
  
  // Special
  SPAWN: 'spawn',
  DESPAWN: 'despawn'
}

/**
 * Base Animation State class
 * Each animation is represented as a state object with lifecycle methods.
 */
export class AnimationState {
  constructor(config = {}) {
    this.stateType = config.stateType || AnimStateType.IDLE
    this.canInterrupt = config.canInterrupt !== false // Default true
    this.duration = config.duration ?? null // null = looping
    this.blendDuration = config.blendDuration || 150 // ms
    this.priority = config.priority || 0
    this.transitions = config.transitions || []
    this.frameRate = config.frameRate || 8
    this.currentFrame = 0
    this.stateTimer = 0
    this.isComplete = false
  }
  
  /**
   * Called when state becomes active
   */
  enter(context) {
    this.stateTimer = 0
    this.currentFrame = 0
    this.isComplete = false
  }
  
  /**
   * Called when transitioning out
   */
  exit(context) {
    // Cleanup if needed
  }
  
  /**
   * Frame-by-frame updates
   */
  update(deltaTime, context) {
    this.stateTimer += deltaTime
    this.currentFrame = Math.floor((this.stateTimer * this.frameRate) % 4)
    
    // Check if non-looping animation completed
    if (this.duration !== null && this.stateTimer >= this.duration / 1000) {
      this.isComplete = true
    }
  }
  
  /**
   * Override in subclasses for auto-transitions
   */
  checkTransition(context) {
    return null
  }
  
  /**
   * Get sprite key for current state
   */
  getSpriteKey(direction = 0) {
    return this.stateType
  }
  
  /**
   * Reset state to initial values
   */
  reset() {
    this.stateTimer = 0
    this.currentFrame = 0
    this.isComplete = false
  }
}

/**
 * Movement State - handles directional animations
 */
export class MovementState extends AnimationState {
  constructor(direction) {
    super({
      stateType: MovementState.getAnimForDirection(direction),
      canInterrupt: true,
      blendDuration: 100
    })
    this.direction = direction
  }
  
  static getAnimForDirection(direction) {
    // direction: 0=down, 1=left, 2=up, 3=right
    const anims = [AnimStateType.WALK_DOWN, AnimStateType.WALK_SIDE, 
            AnimStateType.WALK_UP, AnimStateType.WALK_SIDE]
    return anims[direction] || AnimStateType.WALK_DOWN
  }
  
  getSpriteKey(direction = 0) {
    return MovementState.getAnimForDirection(direction)
  }
}

/**
 * Emote State - one-shot animations with auto-return
 */
export class EmoteState extends AnimationState {
  constructor(config) {
    super({
      ...config,
      duration: config.duration || 2000,
      canInterrupt: config.canInterrupt ?? false
    })
    this.returnState = config.returnState || AnimStateType.IDLE
  }
  
  checkTransition(context) {
    if (this.isComplete) {
      return this.returnState
    }
    return null
  }
}

/**
 * Transition State - gap-filling animations
 * Used for smooth transitions between significantly different states
 */
export class TransitionState extends AnimationState {
  constructor(config) {
    super({
      ...config,
      duration: config.duration || 300,
      canInterrupt: false,
      priority: 100
    })
    this.targetState = config.targetState
  }
  
  checkTransition(context) {
    if (this.isComplete) {
      return this.targetState
    }
    return null
  }
}

/**
 * Idle State - default looping state with weighted transitions
 */
export class IdleState extends AnimationState {
  constructor(config = {}) {
    super({
      stateType: AnimStateType.IDLE,
      canInterrupt: true,
      duration: null, // Looping
      ...config
    })
    this.idleTransitions = config.idleTransitions || []
  }
  
  checkTransition(context) {
    // Random idle behaviors can trigger here
    if (this.idleTransitions.length > 0 && Math.random() < 0.001) {
      const idx = Math.floor(Math.random() * this.idleTransitions.length)
      return this.idleTransitions[idx]
    }
    return null
  }
}

/**
 * Create animation state from config
 */
export function createAnimationState(config) {
  const { stateType, ...rest } = config
  
  // Determine state class based on type
  if (stateType?.startsWith('walk')) {
    return new MovementState(
      stateType === AnimStateType.WALK_DOWN ? 0 :
      stateType === AnimStateType.WALK_SIDE ? 1 :
      stateType === AnimStateType.WALK_UP ? 2 : 1
    )
  }
  
  if ([AnimStateType.CHEER, AnimStateType.LOSE, AnimStateType.YAWN, 
       AnimStateType.FACEPALM, AnimStateType.ARGUE, AnimStateType.WHINE,
       AnimStateType.BUY, AnimStateType.SELL, AnimStateType.HODL,
       AnimStateType.MOON, AnimStateType.REKT,
       AnimStateType.BAGHOLDER, AnimStateType.COPIUM, AnimStateType.RUGPULL,
       AnimStateType.LAMBO, AnimStateType.BRRR,
        AnimStateType.BULLTRAP, AnimStateType.DEADCAT, AnimStateType.MELT,
        AnimStateType.BUYDIP, AnimStateType.ROCKET,
        AnimStateType.FATFINGER, AnimStateType.LEVERAGE, AnimStateType.TENDIES,
        AnimStateType.WHALE, AnimStateType.FED].includes(stateType)) {
    return new EmoteState(config)
  }
  
  if ([AnimStateType.STAND_UP, AnimStateType.SIT_DOWN, 
       AnimStateType.TURN_LEFT, AnimStateType.TURN_RIGHT].includes(stateType)) {
    return new TransitionState(config)
  }
  
  return new AnimationState(config)
}
