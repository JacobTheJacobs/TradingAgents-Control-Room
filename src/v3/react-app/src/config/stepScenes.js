/**
 * TradingAgents scene configuration.
 *
 * This file is the frontend source of truth for the 5 Tauric workflow scenes
 * shown during TradingAgents runs. Individual agent events collapse into these
 * team-level scenes.
 */

import {
  TRADING_AGENT_NAMES,
  TRADING_AGENT_SCENE_MAP,
  normalizeTradingAgentId,
  normalizeTradingAgentName,
} from './tradingAgentsRoster'
import { AnimStateType } from '../components/trading-floor/canvas/animation'

export const AnimState = AnimStateType
AnimState.THINK = 'idle'

export const LOCATIONS = {
  DESK: 'desk',
  COOLER: 'cooler',
  TABLE: 'table',
  TV: 'tv',
  SCANNER: 'scanner',
  CENTER: 'center',
  NEWSSTAND: 'newsstand',
  WINDOW: 'window',
  TICKER: 'ticker',
}

export let ALL_AGENTS = [...TRADING_AGENT_NAMES]

export function setAllAgents(agents) {
  if (Array.isArray(agents) && agents.length > 0) {
    ALL_AGENTS = [...agents]
  }
}

export const STEP_SCENES = {
  STEP_1_ANALYSTS: {
    phase: 1,
    name: 'Analyst Team',
    description: 'Market, Social, News, and Fundamentals analysts fan out across the data center.',
    location: LOCATIONS.SCANNER,
    agents: ['Market Analyst', 'Social Analyst', 'News Analyst', 'Fundamentals Analyst'],
    animations: {
      'Market Analyst': AnimState.SIT_TYPE,
      'Social Analyst': AnimState.TALK,
      'News Analyst': AnimState.READ,
      'Fundamentals Analyst': AnimState.READ,
    },
    stations: {
      'Market Analyst': LOCATIONS.SCANNER,
      'Social Analyst': LOCATIONS.COOLER,
      'News Analyst': LOCATIONS.NEWSSTAND,
      'Fundamentals Analyst': LOCATIONS.DESK,
    },
    paths: {
      'Market Analyst': 'direct',
      'Social Analyst': 'direct',
      'News Analyst': 'direct',
      'Fundamentals Analyst': 'direct',
    },
  },
  STEP_2_RESEARCH: {
    phase: 2,
    name: 'Research Team',
    description: 'Bull and Bear researchers debate while the Research Manager synthesizes at the war table.',
    location: LOCATIONS.TABLE,
    agents: ['Bull Researcher', 'Bear Researcher', 'Research Manager'],
    animations: {
      'Bull Researcher': AnimState.TALK,
      'Bear Researcher': AnimState.ARGUE,
      'Research Manager': AnimState.POINT,
    },
    stations: {
      'Bull Researcher': LOCATIONS.TABLE,
      'Bear Researcher': LOCATIONS.TABLE,
      'Research Manager': LOCATIONS.CENTER,
    },
    paths: {
      'Bull Researcher': 'direct',
      'Bear Researcher': 'direct',
      'Research Manager': 'direct',
    },
  },
  STEP_3_TRADER: {
    phase: 3,
    name: 'Trader',
    description: 'Trader turns the research package into an executable trade plan.',
    location: LOCATIONS.TICKER,
    agents: ['Trader'],
    animations: { Trader: AnimState.TALK },
    stations: { Trader: LOCATIONS.TICKER },
    paths: { Trader: 'direct' },
  },
  STEP_4_RISK: {
    phase: 4,
    name: 'Risk Management',
    description: 'Aggressive, Conservative, and Neutral analysts pressure test the proposal at the vault gate.',
    location: LOCATIONS.TV,
    agents: ['Aggressive Analyst', 'Conservative Analyst', 'Neutral Analyst'],
    animations: {
      'Aggressive Analyst': AnimState.TALK,
      'Conservative Analyst': AnimState.READ,
      'Neutral Analyst': AnimState.THINK,
    },
    stations: {
      'Aggressive Analyst': LOCATIONS.TV,
      'Conservative Analyst': LOCATIONS.TV,
      'Neutral Analyst': LOCATIONS.TV,
    },
    paths: {
      'Aggressive Analyst': 'direct',
      'Conservative Analyst': 'direct',
      'Neutral Analyst': 'direct',
    },
  },
  STEP_5_PORTFOLIO: {
    phase: 5,
    name: 'Portfolio Management',
    description: 'Risk Judge delivers the final portfolio call from the terminal.',
    location: LOCATIONS.TICKER,
    agents: ['Risk Judge'],
    animations: { 'Risk Judge': AnimState.POINT },
    stations: { 'Risk Judge': LOCATIONS.TICKER },
    paths: { 'Risk Judge': 'direct' },
  },
}

const PHASE_ALIASES = {
  STEP_1_ANALYSTS: 'STEP_1_ANALYSTS',
  STEP_2_RESEARCH: 'STEP_2_RESEARCH',
  STEP_3_TRADER: 'STEP_3_TRADER',
  STEP_4_RISK: 'STEP_4_RISK',
  STEP_5_PORTFOLIO: 'STEP_5_PORTFOLIO',
  ANALYSTS: 'STEP_1_ANALYSTS',
  MARKET: 'STEP_1_ANALYSTS',
  SOCIAL: 'STEP_1_ANALYSTS',
  NEWS: 'STEP_1_ANALYSTS',
  FUNDAMENTALS: 'STEP_1_ANALYSTS',
  FUNDS: 'STEP_1_ANALYSTS',
  MARKET_ANALYST: 'STEP_1_ANALYSTS',
  SOCIAL_ANALYST: 'STEP_1_ANALYSTS',
  SOCIAL_MEDIA_ANALYST: 'STEP_1_ANALYSTS',
  NEWS_ANALYST: 'STEP_1_ANALYSTS',
  FUNDAMENTALS_ANALYST: 'STEP_1_ANALYSTS',
  MARKET_REPORT: 'STEP_1_ANALYSTS',
  SENTIMENT_REPORT: 'STEP_1_ANALYSTS',
  SOCIAL_REPORT: 'STEP_1_ANALYSTS',
  NEWS_REPORT: 'STEP_1_ANALYSTS',
  FUNDAMENTALS_REPORT: 'STEP_1_ANALYSTS',
  RESEARCH: 'STEP_2_RESEARCH',
  RESEARCHERS: 'STEP_2_RESEARCH',
  BULL_RESEARCHER: 'STEP_2_RESEARCH',
  BEAR_RESEARCHER: 'STEP_2_RESEARCH',
  RESEARCH_MANAGER: 'STEP_2_RESEARCH',
  RESEARCH_JUDGE: 'STEP_2_RESEARCH',
  INVESTMENT_PLAN: 'STEP_2_RESEARCH',
  TRADER: 'STEP_3_TRADER',
  TRADER_INVESTMENT_PLAN: 'STEP_3_TRADER',
  AGGRESSIVE_ANALYST: 'STEP_4_RISK',
  CONSERVATIVE_ANALYST: 'STEP_4_RISK',
  NEUTRAL_ANALYST: 'STEP_4_RISK',
  RISK: 'STEP_4_RISK',
  DECISION: 'STEP_5_PORTFOLIO',
  RISK_JUDGE: 'STEP_5_PORTFOLIO',
  RISK_MANAGER: 'STEP_5_PORTFOLIO',
  PORTFOLIO: 'STEP_5_PORTFOLIO',
  PORTFOLIO_MANAGER: 'STEP_5_PORTFOLIO',
  FINAL_TRADE_DECISION: 'STEP_5_PORTFOLIO',
}

export function getStepScene(phase) {
  if (!phase) return null
  const asAgentId = normalizeTradingAgentId(phase)
  if (asAgentId && TRADING_AGENT_SCENE_MAP[asAgentId]) {
    return STEP_SCENES[TRADING_AGENT_SCENE_MAP[asAgentId]] || null
  }

  const key = String(phase).toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_')
  const canonicalKey = PHASE_ALIASES[key] || key
  return STEP_SCENES[canonicalKey] || null
}

export function getAgentAnimation(phase, agent) {
  const scene = getStepScene(phase)
  if (!scene) return AnimState.IDLE

  const canonicalName = normalizeTradingAgentName(agent)
  if (scene.animations[canonicalName]) {
    return scene.animations[canonicalName]
  }

  if (scene.animations[agent]) {
    return scene.animations[agent]
  }

  return scene.animations.default || AnimState.IDLE
}

export function getPhaseAgents(phase) {
  const scene = getStepScene(phase)
  if (!scene) return []
  if (scene.agents.includes('all')) return ALL_AGENTS
  return scene.agents
}

export function buildReplayDialogue(scriptData) {
  const dialogue = []
  if (!scriptData) return dialogue

  Object.keys(STEP_SCENES)
    .sort((a, b) => STEP_SCENES[a].phase - STEP_SCENES[b].phase)
    .forEach((key) => {
      const step = STEP_SCENES[key]
      const phaseData = scriptData[key]
      const phaseLines = phaseData?.dialogue

      if (Array.isArray(phaseLines) && phaseLines.length > 0) {
        dialogue.push({
          agent: 'SYSTEM',
          text: `--- STEP ${step.phase}: ${step.name} ---`,
        })

        phaseLines.forEach((line) => {
          if (line?.agent && line?.text) {
            dialogue.push({
              agent: normalizeTradingAgentName(line.agent) || line.agent,
              text: line.text,
            })
          }
        })
      }
    })

  return dialogue
}

export default STEP_SCENES
