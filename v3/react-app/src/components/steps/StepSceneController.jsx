/**
 * StepSceneController.jsx
 * 
 * Central controller that connects pipeline phases to:
 * - Agent movement (via Showrunner)
 * - Animation states (via AnimationController)
 * - Dialogue scripts (via DialogueBoxPanel)
 * 
 * Listens to pipeline_phase WebSocket messages and triggers
 * the appropriate scene for each phase.
 */

import { useEffect, useCallback, useRef } from 'react'
import { getStepScene, STEP_SCENES, ALL_AGENTS, LOCATIONS, AnimState, buildReplayDialogue } from '../../config/stepScenes'
import { dispatchSceneCommand, SceneCommandType } from '../trading-floor/canvas/Showrunner'
import { useTradingFloor } from '../../context/TradingFloorContext'

const WIN_EMOTES = [
  AnimState.CHEER, AnimState.ROCKET, AnimState.TENDIES, AnimState.LAMBO,
  AnimState.MOON, AnimState.WHALE, AnimState.BUYDIP, AnimState.HODL
]
const LOSE_EMOTES = [
  AnimState.WHINE, AnimState.FACEPALM, AnimState.REKT, AnimState.MELT,
  AnimState.RUGPULL, AnimState.DEADCAT, AnimState.COPIUM, AnimState.SELL
]
const NEUTRAL_EMOTES = [
  AnimState.IDLE, AnimState.READ, AnimState.TALK, AnimState.SIT_TYPE,
  AnimState.SIT_BACK, AnimState.DRINK, AnimState.POINT
]

const ALL_STATIONS = Object.values(LOCATIONS)

const pickRandom = (items) => items[Math.floor(Math.random() * items.length)]

const shuffle = (items) => {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const clamp = (val, min, max) => Math.max(min, Math.min(max, val))

const getMoodChance = (pnlPct) => {
  const intensity = clamp(Math.abs(pnlPct) / 0.01, 0, 1) // 1% daily move => full intensity
  return clamp(0.4 + intensity * 0.5, 0.4, 0.9)
}

const pickMoodAnimation = (pnlPct) => {
  if (pnlPct > 0) {
    const winChance = getMoodChance(pnlPct)
    return Math.random() < winChance ? pickRandom(WIN_EMOTES) : pickRandom(NEUTRAL_EMOTES)
  }
  if (pnlPct < 0) {
    const loseChance = getMoodChance(pnlPct)
    return Math.random() < loseChance ? pickRandom(LOSE_EMOTES) : pickRandom(NEUTRAL_EMOTES)
  }
  return pickRandom(NEUTRAL_EMOTES)
}

const selectVariant = (scene) => {
  if (!scene?.variants || scene.variants.length === 0) return null
  return pickRandom(scene.variants)
}

const buildScenePlan = (phase, scene, portfolio) => {
  const variant = selectVariant(scene)
  const baseLocation = variant?.location || scene.location
  const featuredAgents = variant?.agents || scene.agents || []
  const baseAnimations = variant?.animations || scene.animations || {}

  const totalValue = portfolio?.total_value || 0
  const dailyPnl = portfolio?.daily_pnl || 0
  const pnlPct = totalValue ? dailyPnl / totalValue : 0
  const perAgentPnl = portfolio?.agent_pnl || {}

  const sideLocations = ALL_STATIONS.filter(loc => loc !== baseLocation)
  const shuffledLocations = shuffle(sideLocations.length ? sideLocations : ALL_STATIONS)
  let sideIdx = 0

  const agentStations = {}
  const agentAnimations = {}

  ALL_AGENTS.forEach(agent => {
    const isFeatured = featuredAgents.includes(agent) || featuredAgents.includes('all')
    const station = isFeatured ? baseLocation : shuffledLocations[sideIdx++ % shuffledLocations.length]
    agentStations[agent] = station

    const baseAnim = baseAnimations[agent] || baseAnimations.default
    const agentPnl = perAgentPnl[agent]
    const agentPct = typeof agentPnl === 'number' && totalValue ? agentPnl / totalValue : pnlPct
    if (agentPct !== 0) {
      agentAnimations[agent] = pickMoodAnimation(agentPct)
    } else {
      agentAnimations[agent] = baseAnim || pickRandom(NEUTRAL_EMOTES)
    }
  })

  return {
    variantName: variant?.name || null,
    baseLocation,
    featuredAgents,
    baseAnimations,
    agentStations,
    agentAnimations,
  }
}

const getScriptDialogue = (phase, stepScript) => {
  if (!stepScript) return null
  const key = phase.toUpperCase()
  const phases = stepScript.phases || stepScript
  const entry = phases?.[key]
  if (!entry) return null
  return {
    headline: entry.headline,
    dialogue: entry.dialogue || []
  }
}

/**
 * Generate fallback dialogue when LLM is unavailable
 */
function generateFallbackDialogue(phase, ticker, regime) {
  const scene = getStepScene(phase)
  if (!scene) return []
  const sceneKey = Object.entries(STEP_SCENES).find(([, candidate]) => candidate === scene)?.[0]
  const fallbacks = {
    STEP_1_ANALYSTS: [
      { agent: 'Market Analyst', text: `${ticker || 'The tape'} still needs clean confirmation before I trust the move.` },
      { agent: 'Social Analyst', text: `The crowd is loud, but I care whether the flow is accelerating or fading.` },
      { agent: 'News Analyst', text: `Headline risk is real. I only care about catalysts that can change the trade today.` },
      { agent: 'Fundamentals Analyst', text: `If the business quality does not support the setup, the chart will not save it.` },
    ],
    STEP_2_RESEARCH: [
      { agent: 'Bull Researcher', text: `There is upside here if execution matches the narrative.` },
      { agent: 'Bear Researcher', text: `Then prove the downside is priced, not ignored.` },
      { agent: 'Research Manager', text: `Good. Keep the thesis tight and the weak assumptions exposed.` },
    ],
    STEP_3_TRADER: [
      { agent: 'Trader', text: `I need an entry, a stop, and a size that survives bad tape.` },
    ],
    STEP_4_RISK: [
      { agent: 'Aggressive Analyst', text: `If the setup is real, under-sizing is its own mistake.` },
      { agent: 'Conservative Analyst', text: `Only if the downside is defined first.` },
      { agent: 'Neutral Analyst', text: `Balance the asymmetry against the cash we still need to keep.` },
    ],
    STEP_5_PORTFOLIO: [
      { agent: 'Risk Judge', text: `Size follows evidence, not excitement.` },
    ],
  }
  
  return fallbacks[sceneKey || phase] || [{ agent: 'SYSTEM', text: `${scene?.name || phase} phase initiated.` }]
}

/**
 * StepSceneController Component
 * 
 * @param {Object} props
 * @param {string} props.pipelinePhase - Current pipeline phase
 * @param {string} props.regime - Current market regime
 * @param {string} props.ticker - Current ticker being analyzed
 * @param {Object} props.stepScript - Pre-generated 5-step dialogue script
 * @param {Object} props.stepScriptMeta - Script metadata (ticker, cycle, generated_at)
 * @param {boolean} props.enabled - Whether auto-triggering is enabled
 */
export function StepSceneController({
  pipelinePhase,
  regime,
  ticker,
  portfolio,
  stepScript = null,
  stepScriptMeta = null,
  enabled = true,
}) {
  const { state, setActiveScene } = useTradingFloor()
  const lastPhaseRef = useRef(null)
  const isProcessingRef = useRef(false)
  const lastSignatureRef = useRef({})
  const lastScriptRef = useRef({})
  const pendingSceneRef = useRef(null)
  const lastReplayRef = useRef(null)
  
  /**
   * Trigger a step scene
   */
  const triggerScene = useCallback(async (phase) => {
    if (isProcessingRef.current) {
      console.log(`[StepSceneController] Already processing, skipping ${phase}`)
      pendingSceneRef.current = phase
      return
    }
    
    const scene = getStepScene(phase)
    if (!scene) {
      console.log(`[StepSceneController] No scene config for phase: ${phase}`)
      return
    }
    
    isProcessingRef.current = true
    console.log(`[StepSceneController] Triggering scene for phase: ${phase}`)
    
    const planAttempts = 6
    let plan = null
    for (let i = 0; i < planAttempts; i++) {
      const candidate = buildScenePlan(phase, scene, portfolio)
      const signature = JSON.stringify({
        phase,
        variant: candidate.variantName,
        stations: candidate.agentStations,
        animations: candidate.agentAnimations,
      })
      if (signature !== lastSignatureRef.current[phase]) {
        plan = { ...candidate, signature }
        break
      }
      if (i === planAttempts - 1) {
        plan = { ...candidate, signature }
      }
    }
    lastSignatureRef.current[phase] = plan.signature

    const agents = scene.agents.includes('all') ? [...ALL_AGENTS] : [...scene.agents]
    const basePaths = scene.paths || {}
    const agentPaths = agents.reduce((map, agent) => {
      map[agent] = basePaths[agent] || basePaths.default || 'direct'
      return map
    }, {})
    
    // 1. Dispatch movement command to Showrunner
    dispatchSceneCommand({
      type: SceneCommandType.PLAY_STEP_SCENE,
      phase: phase,
      agents: agents,
      location: plan.baseLocation,
      animations: plan.baseAnimations,
      agentStations: plan.agentStations,
      agentAnimations: plan.agentAnimations,
      agentPaths,
      variant: plan.variantName,
    })
    
    // 2. Resolve dialogue from pre-generated script (with fallback)
    const scriptEntry = getScriptDialogue(phase, stepScript)
    const scriptId = stepScriptMeta?.script_id || stepScriptMeta?.generated_at || null
    let dialogue = scriptEntry?.dialogue || []
    const scriptHeadline = scriptEntry?.headline || null

    if (!dialogue || dialogue.length === 0) {
      console.log(`[StepSceneController] Using fallback dialogue for ${phase}`)
      dialogue = generateFallbackDialogue(phase, ticker, regime)
    }

    if (scriptId) {
      lastScriptRef.current[phase] = scriptId
    }
    
    // 3. Set active scene for DialogueBoxPanel
    const baseHeadline = scriptHeadline || scene.dialogueTemplate?.headline || `${phase} Phase`
    setActiveScene({
      headline: plan.variantName ? `${baseHeadline} • ${plan.variantName}` : baseHeadline,
      agents: agents,
      dialogue: dialogue,
      phase: phase,
      ticker: ticker,
      location: plan.baseLocation,
      animations: plan.baseAnimations,
      agentStations: plan.agentStations,
      agentAnimations: plan.agentAnimations,
      agentPaths,
    })
    
    // Reset processing flag after a delay
    setTimeout(() => {
      isProcessingRef.current = false
      if (pendingSceneRef.current) {
        const nextPhase = pendingSceneRef.current
        pendingSceneRef.current = null
        triggerScene(nextPhase)
      }
    }, 2000)
  }, [ticker, regime, setActiveScene, portfolio, stepScript, stepScriptMeta])
  
  /**
   * Listen for pipeline phase changes
   */
  useEffect(() => {
    if (!enabled || !pipelinePhase) return
    
    // Skip if same phase (debounce)
    if (pipelinePhase === lastPhaseRef.current) {
      return
    }
    
    // Skip idle phase
    if (pipelinePhase.toLowerCase() === 'idle') {
      lastPhaseRef.current = pipelinePhase
      return
    }
    
    console.log(`[StepSceneController] Phase changed: ${lastPhaseRef.current} -> ${pipelinePhase}`)
    lastPhaseRef.current = pipelinePhase
    
    // Trigger the scene
    triggerScene(pipelinePhase.toUpperCase())
    
  }, [pipelinePhase, enabled, triggerScene])

  /**
   * Replay full script when a new script arrives and pipeline is idle.
   * This ensures late-arriving scripts still appear in the dialogue box.
   */
  useEffect(() => {
    if (!enabled || !stepScript) return
    if (pipelinePhase && pipelinePhase.toLowerCase() !== 'idle') return
    if (state?.activeScene) return

    const scriptId = stepScriptMeta?.script_id || stepScriptMeta?.generated_at
    if (!scriptId || lastReplayRef.current === scriptId) return

    const replayDialogue = buildReplayDialogue(stepScript)
    if (!replayDialogue.length) return

    lastReplayRef.current = scriptId
    setActiveScene({
      headline: stepScriptMeta?.ticker
        ? `FULL SCRIPT • ${stepScriptMeta.ticker}`
        : 'FULL SCRIPT',
      agents: ALL_AGENTS,
      dialogue: replayDialogue,
      phase: 'REPLAY',
      ticker: stepScriptMeta?.ticker || ticker,
    })
  }, [enabled, stepScript, stepScriptMeta, pipelinePhase, state?.activeScene, setActiveScene, ticker])

  /**
   * Re-trigger current phase when a new script arrives
   */
  useEffect(() => {
    if (!enabled || !stepScript || !pipelinePhase) return
    if (pipelinePhase.toLowerCase() === 'idle') return

    const phaseKey = pipelinePhase.toUpperCase()
    const scriptId = stepScriptMeta?.script_id || stepScriptMeta?.generated_at
    if (!scriptId) return

    if (lastScriptRef.current[phaseKey] === scriptId) return

    triggerScene(phaseKey)
  }, [stepScript, stepScriptMeta, pipelinePhase, enabled, triggerScene])
  
  /**
   * Manual trigger for admin panel
   */
  const manualTrigger = useCallback((phase) => {
    console.log(`[StepSceneController] Manual trigger for: ${phase}`)
    lastPhaseRef.current = null // Reset to allow re-trigger
    triggerScene(phase)
  }, [triggerScene])

  /**
   * Replay the full script on demand (admin button)
   */
  const replayScript = useCallback(() => {
    if (!stepScript) return
    const replayDialogue = buildReplayDialogue(stepScript)
    if (!replayDialogue.length) return

    const headline = stepScriptMeta?.ticker
      ? `FULL SCRIPT • ${stepScriptMeta.ticker}`
      : 'FULL SCRIPT'

    setActiveScene({
      headline,
      agents: ALL_AGENTS,
      dialogue: replayDialogue,
      phase: 'REPLAY',
      ticker: stepScriptMeta?.ticker || ticker,
    })
  }, [stepScript, stepScriptMeta, setActiveScene, ticker])
  
  // Expose manual trigger for admin use via window global
  useEffect(() => {
    window.stepSceneController = {
      triggerScene: manualTrigger,
      replayScript,
      currentPhase: lastPhaseRef.current,
      stepScenes: STEP_SCENES,
    }
    return () => {
      window.stepSceneController = null
    }
  }, [manualTrigger, replayScript])

  // This is a "headless" component - it doesn't render anything
  return null
}

export default StepSceneController
