/**
 * Animation State Management System
 * 
 * Simplified for 16-bit pixel art style:
 * - Snappy frame swaps (no blending - preserves pixel clarity)
 * - Priority-based animation queue
 * - Gap-filling mechanism for mid-playback interruptions
 * - Event-driven animation triggering
 * - Proper cleanup and resource management
 */

// Core exports
export { AnimationController } from './AnimationController'
export { AnimationStateMachine } from './AnimationStateMachine'
export { EventRouter } from './EventRouter'
export { ResourcePool } from './ResourcePool'

// State types and classes
export { 
  AnimStateType,
  AnimationState,
  MovementState,
  EmoteState,
  TransitionState,
  IdleState,
  createAnimationState
} from './AnimationState'

// Default export - the main orchestrator
export { AnimationController as default } from './AnimationController'
