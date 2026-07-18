/**
 * Animations index - exports all animation functions
 */

// Agent animation creators
export { createAgentAnimations, createAllAnimations } from './agentAnimations'

// Idle animation definitions and helpers
export {
  IDLE_ANIMATIONS,
  IDLE_CATEGORIES,
  SCHEDULE_IDLE_MAP,
  getRandomIdleAnimation,
  getAnimationDuration
} from './idleAnimations'
