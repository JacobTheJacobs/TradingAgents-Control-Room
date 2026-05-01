/**
 * Steps Module
 * 
 * Exports step scene controller and utilities for
 * connecting pipeline phases to canvas animations.
 */

export { StepSceneController, useStepScene } from './StepSceneController'

// Re-export config utilities
export {
  getStepScene,
  getPhaseAgents,
  getAgentAnimation,
  STEP_SCENES,
  ALL_AGENTS,
  LOCATIONS,
  AnimState,
} from '../../config/stepScenes'
