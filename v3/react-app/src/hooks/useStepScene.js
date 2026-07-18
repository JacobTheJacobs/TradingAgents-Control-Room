import { getStepScene, getPhaseAgents, getAgentAnimation, STEP_SCENES } from '../config/stepScenes'

/**
 * Hook to get step scene utilities
 * Separated from StepSceneController to satisfy Vite Fast Refresh rules
 */
export function useStepScene() {
  return {
    getStepScene,
    getPhaseAgents,
    getAgentAnimation,
    stepScenes: STEP_SCENES,
  }
}
