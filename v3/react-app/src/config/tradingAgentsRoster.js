const STATION_TILE_MAP = {
  desk: 2,
  scanner: 14,
  tv: 11,
  cooler: 4,
  table: 15,
  ticker: 3,
  newsstand: 5,
  window: 12,
  center: 15,
}

export const TRADING_AGENT_DEFS = [
  {
    id: 'market_analyst',
    name: 'Market Analyst',
    shortLabel: 'Market',
    station: 'scanner',
    color: '#9370DB',
    personality: 'Tracks price action, structure, and technical momentum.',
    position: { x: 112, y: 96 },
    aliases: ['Market', 'market', 'market analyst', 'market_analyst', 'technical analyst', 'technical_analyst'],
    portrait: { folder: 'market analyist', bases: ['market analyst'] },
  },
  {
    id: 'social_analyst',
    name: 'Social Analyst',
    shortLabel: 'Social',
    station: 'cooler',
    color: '#1E90FF',
    personality: 'Reads crowd psychology, meme flow, and retail sentiment.',
    position: { x: 272, y: 96 },
    aliases: ['Social', 'social', 'social analyst', 'social_analyst', 'social media analyst', 'social_media_analyst', 'sentiment analyst', 'sentiment_analyst'],
    portrait: { folder: 'social analysit', bases: ['social analysit'] },
  },
  {
    id: 'news_analyst',
    name: 'News Analyst',
    shortLabel: 'News',
    station: 'newsstand',
    color: '#4ECDC4',
    personality: 'Monitors breaking headlines, filings, and catalysts.',
    position: { x: 496, y: 96 },
    aliases: ['News', 'news', 'news analyst', 'news_analyst'],
    portrait: { folder: 'News Analyst', bases: ['News Analyst'] },
  },
  {
    id: 'fundamentals_analyst',
    name: 'Fundamentals Analyst',
    shortLabel: 'Fundamentals',
    station: 'desk',
    color: '#BA55D3',
    personality: 'Underwrites balance sheet quality, valuation, and business durability.',
    position: { x: 208, y: 192 },
    aliases: ['Fundamentals', 'fundamental', 'fundamentals analyst', 'fundamentals_analyst', 'fundamental analyst', 'fundamental_analyst'],
    portrait: { folder: 'funadametals agent', bases: ['funadametals agent'] },
  },
  {
    id: 'bull_researcher',
    name: 'Bull Researcher',
    shortLabel: 'Bull',
    station: 'table',
    color: '#F8B500',
    personality: 'Builds the strongest upside case and leans into convexity.',
    position: { x: 400, y: 192 },
    aliases: ['Bull', 'bull', 'bull researcher', 'bull_researcher'],
    portrait: { folder: 'bull research', bases: ['bull research'] },
  },
  {
    id: 'bear_researcher',
    name: 'Bear Researcher',
    shortLabel: 'Bear',
    station: 'table',
    color: '#2D3436',
    personality: 'Attacks the thesis and looks for hidden downside.',
    position: { x: 112, y: 288 },
    aliases: ['Bear', 'bear', 'bear researcher', 'bear_researcher'],
    portrait: { folder: 'doomer_bear', bases: ['doomer_bear_sprite_1773096038694'] },
  },
  {
    id: 'research_manager',
    name: 'Research Manager',
    shortLabel: 'Research Manager',
    station: 'table',
    color: '#32CD32',
    personality: 'Synthesizes the debate and decides when research is complete.',
    position: { x: 496, y: 288 },
    aliases: ['Research Manager', 'research manager', 'research_manager', 'research judge', 'research_judge', 'research director', 'research_director'],
    portrait: { folder: 'resesrah manager', bases: ['resesrah manager'] },
  },
  {
    id: 'trader',
    name: 'Trader',
    shortLabel: 'Trader',
    station: 'ticker',
    color: '#7851A9',
    personality: 'Turns research into a concrete trade plan with timing and structure.',
    position: { x: 272, y: 176 },
    aliases: ['Trader', 'trader'],
    portrait: { folder: 'Trader', bases: ['Trader'] },
  },
  {
    id: 'aggressive_analyst',
    name: 'Aggressive Analyst',
    shortLabel: 'Aggressive',
    station: 'tv',
    color: '#FF6B6B',
    personality: 'Pushes for size, speed, and upside capture.',
    position: { x: 208, y: 176 },
    aliases: ['Aggressive', 'aggressive', 'aggressive analyst', 'aggressive_analyst'],
    portrait: { folder: 'aggresive anlaysit', bases: ['aggresive anlaysit'] },
  },
  {
    id: 'conservative_analyst',
    name: 'Conservative Analyst',
    shortLabel: 'Conservative',
    station: 'tv',
    color: '#7DF9FF',
    personality: 'Presses for tighter risk, tighter sizing, and better downside protection.',
    position: { x: 144, y: 240 },
    aliases: ['Conservative', 'conservative', 'conservative analyst', 'conservative_analyst'],
    portrait: { folder: 'Conservative Analyst', bases: ['Conservative Analyst'] },
  },
  {
    id: 'neutral_analyst',
    name: 'Neutral Analyst',
    shortLabel: 'Neutral',
    station: 'tv',
    color: '#D4AF37',
    personality: 'Balances both sides and looks for the cleanest compromise.',
    position: { x: 272, y: 240 },
    aliases: ['Neutral', 'neutral', 'neutral analyst', 'neutral_analyst'],
    portrait: { folder: 'neutaral anaylsti', bases: ['neutaral anaylsti'] },
  },
  {
    id: 'risk_judge',
    name: 'Risk Judge',
    shortLabel: 'Risk Judge',
    station: 'ticker',
    color: '#A0522D',
    personality: 'Makes the final risk call and signs off on the position.',
    position: { x: 400, y: 192 },
    aliases: ['Risk Judge', 'risk judge', 'risk_judge', 'Risk Manager', 'risk manager', 'risk_manager', 'Portfolio Manager', 'portfolio manager', 'portfolio_manager'],
    portrait: { folder: 'Risk Judge', bases: ['Risk Judge'] },
  },
]

export const TRADING_AGENT_IDS = TRADING_AGENT_DEFS.map((agent) => agent.id)
export const TRADING_AGENT_NAMES = TRADING_AGENT_DEFS.map((agent) => agent.name)
export const TRADING_AGENT_BY_ID = Object.fromEntries(
  TRADING_AGENT_DEFS.map((agent) => [agent.id, agent])
)

export const TRADING_AGENT_WORKFLOW_STEPS = [
  {
    key: 'STEP_1_ANALYSTS',
    reportKey: 'analyst_team',
    step: 1,
    label: 'Analyst Team',
    shortLabel: 'ANALYSTS',
    agents: ['market_analyst', 'social_analyst', 'news_analyst', 'fundamentals_analyst'],
  },
  {
    key: 'STEP_2_RESEARCH',
    reportKey: 'research_team',
    step: 2,
    label: 'Research Team',
    shortLabel: 'RESEARCH',
    agents: ['bull_researcher', 'bear_researcher', 'research_manager'],
  },
  {
    key: 'STEP_3_TRADER',
    reportKey: 'trader',
    step: 3,
    label: 'Trader',
    shortLabel: 'TRADER',
    agents: ['trader'],
  },
  {
    key: 'STEP_4_RISK',
    reportKey: 'risk_management',
    step: 4,
    label: 'Risk Management',
    shortLabel: 'RISK',
    agents: ['aggressive_analyst', 'conservative_analyst', 'neutral_analyst'],
  },
  {
    key: 'STEP_5_PORTFOLIO',
    reportKey: 'portfolio_management',
    step: 5,
    label: 'Portfolio Management',
    shortLabel: 'PORTFOLIO',
    agents: ['risk_judge'],
  },
]

export const TRADING_AGENT_REPORT_SECTIONS = [
  {
    key: 'market_report',
    label: 'Market Report',
    shortLabel: 'MARKET',
    agents: ['market_analyst'],
  },
  {
    key: 'sentiment_report',
    label: 'Sentiment Report',
    shortLabel: 'SOCIAL',
    agents: ['social_analyst'],
  },
  {
    key: 'news_report',
    label: 'News Report',
    shortLabel: 'NEWS',
    agents: ['news_analyst'],
  },
  {
    key: 'fundamentals_report',
    label: 'Fundamentals Report',
    shortLabel: 'FUND',
    agents: ['fundamentals_analyst'],
  },
  {
    key: 'investment_plan',
    label: 'Research Plan',
    shortLabel: 'PLAN',
    agents: ['research_manager'],
  },
  {
    key: 'trader_investment_plan',
    label: 'Trader Plan',
    shortLabel: 'TRADER',
    agents: ['trader'],
  },
  {
    key: 'final_trade_decision',
    label: 'Portfolio Decision',
    shortLabel: 'FINAL',
    agents: ['risk_judge'],
  },
]

export const TRADING_AGENT_TIMELINE_SCENES = [
  {
    index: 0,
    key: 'TA_TIMELINE_00_INIT',
    name: 'INIT',
    label: '00 INIT',
    phaseKey: 'STEP_1_ANALYSTS',
    reportSlot: 0,
    agentId: null,
    shortLabel: 'INIT',
    rawStatePaths: [],
  },
  {
    index: 1,
    key: 'TA_TIMELINE_01_MARKET',
    name: 'Market Report',
    label: '01 Market Report',
    phaseKey: 'STEP_1_ANALYSTS',
    reportSlot: 1,
    agentId: 'market_analyst',
    shortLabel: 'MARKET',
    rawStatePaths: [['market_report']],
  },
  {
    index: 2,
    key: 'TA_TIMELINE_02_SENTIMENT',
    name: 'Sentiment Report',
    label: '02 Sentiment Report',
    phaseKey: 'STEP_1_ANALYSTS',
    reportSlot: 2,
    agentId: 'social_analyst',
    shortLabel: 'SOCIAL',
    rawStatePaths: [['sentiment_report']],
  },
  {
    index: 3,
    key: 'TA_TIMELINE_03_NEWS',
    name: 'News Report',
    label: '03 News Report',
    phaseKey: 'STEP_1_ANALYSTS',
    reportSlot: 3,
    agentId: 'news_analyst',
    shortLabel: 'NEWS',
    rawStatePaths: [['news_report']],
  },
  {
    index: 4,
    key: 'TA_TIMELINE_04_FUNDAMENTALS',
    name: 'Fundamentals Report',
    label: '04 Fundamentals Report',
    phaseKey: 'STEP_1_ANALYSTS',
    reportSlot: 4,
    agentId: 'fundamentals_analyst',
    shortLabel: 'FUND',
    rawStatePaths: [['fundamentals_report']],
  },
  {
    index: 5,
    key: 'TA_TIMELINE_05_BULL',
    name: 'Bull Researcher Report',
    label: '05 Bull Researcher Report',
    phaseKey: 'STEP_2_RESEARCH',
    reportSlot: 5,
    agentId: 'bull_researcher',
    shortLabel: 'BULL',
    rawStatePaths: [
      ['investment_debate_state', 'bull_history'],
      ['investment_debate_state', 'current_response'],
    ],
  },
  {
    index: 6,
    key: 'TA_TIMELINE_06_BEAR',
    name: 'Bear Researcher Report',
    label: '06 Bear Researcher Report',
    phaseKey: 'STEP_2_RESEARCH',
    reportSlot: 6,
    agentId: 'bear_researcher',
    shortLabel: 'BEAR',
    rawStatePaths: [['investment_debate_state', 'bear_history']],
  },
  {
    index: 7,
    key: 'TA_TIMELINE_07_MANAGER',
    name: 'Research Manager Report',
    label: '07 Research Manager Report',
    phaseKey: 'STEP_2_RESEARCH',
    reportSlot: 7,
    agentId: 'research_manager',
    shortLabel: 'RM',
    rawStatePaths: [
      ['investment_debate_state', 'judge_decision'],
      ['investment_plan'],
    ],
  },
  {
    index: 8,
    key: 'TA_TIMELINE_08_TRADER',
    name: 'Trader Plan Report',
    label: '08 Trader Plan Report',
    phaseKey: 'STEP_3_TRADER',
    reportSlot: 8,
    agentId: 'trader',
    shortLabel: 'TRADER',
    rawStatePaths: [['trader_investment_plan']],
  },
  {
    index: 9,
    key: 'TA_TIMELINE_09_AGGRESSIVE',
    name: 'Aggressive Analyst Report',
    label: '09 Aggressive Analyst Report',
    phaseKey: 'STEP_4_RISK',
    reportSlot: 9,
    agentId: 'aggressive_analyst',
    shortLabel: 'AGGR',
    rawStatePaths: [
      ['risk_debate_state', 'aggressive_history'],
      ['risk_debate_state', 'current_aggressive_response'],
    ],
  },
  {
    index: 10,
    key: 'TA_TIMELINE_10_CONSERVATIVE',
    name: 'Conservative Analyst Report',
    label: '10 Conservative Analyst Report',
    phaseKey: 'STEP_4_RISK',
    reportSlot: 10,
    agentId: 'conservative_analyst',
    shortLabel: 'CONS',
    rawStatePaths: [
      ['risk_debate_state', 'conservative_history'],
      ['risk_debate_state', 'current_conservative_response'],
    ],
  },
  {
    index: 11,
    key: 'TA_TIMELINE_11_NEUTRAL',
    name: 'Neutral Analyst Report',
    label: '11 Neutral Analyst Report',
    phaseKey: 'STEP_4_RISK',
    reportSlot: 11,
    agentId: 'neutral_analyst',
    shortLabel: 'NEUTRAL',
    rawStatePaths: [
      ['risk_debate_state', 'neutral_history'],
      ['risk_debate_state', 'current_neutral_response'],
    ],
  },
  {
    index: 12,
    key: 'TA_TIMELINE_12_PORTFOLIO',
    name: 'Portfolio Decision Report',
    label: '12 Portfolio Decision Report',
    phaseKey: 'STEP_5_PORTFOLIO',
    reportSlot: 12,
    agentId: 'risk_judge',
    shortLabel: 'JUDGE',
    rawStatePaths: [
      ['risk_debate_state', 'judge_decision'],
      ['final_trade_decision'],
      ['final_decision'],
    ],
  },
]

export const TRADING_AGENT_TIMELINE_SCENE_BY_KEY = Object.fromEntries(
  TRADING_AGENT_TIMELINE_SCENES.map((scene) => [scene.key, scene])
)

export const TRADING_AGENT_TIMELINE_SCENE_BY_INDEX = Object.fromEntries(
  TRADING_AGENT_TIMELINE_SCENES.map((scene) => [scene.index, scene])
)

export const TRADING_AGENT_TIMELINE_SCENE_BY_AGENT = Object.fromEntries(
  TRADING_AGENT_TIMELINE_SCENES
    .filter((scene) => scene.agentId)
    .map((scene) => [scene.agentId, scene])
)

export const TRADING_AGENT_REPORT_CARD_DEFS = TRADING_AGENT_TIMELINE_SCENES
  .filter((scene) => scene.reportSlot > 0 && scene.agentId)
  .map((scene) => ({
    key: scene.agentId,
    agentId: scene.agentId,
    label: scene.name,
    shortLabel: scene.shortLabel,
    reportSlot: scene.reportSlot,
    timelineKey: scene.key,
    timelineIndex: scene.index,
    rawStatePaths: scene.rawStatePaths,
  }))

export const TRADING_AGENT_REPORT_CARD_BY_AGENT = Object.fromEntries(
  TRADING_AGENT_REPORT_CARD_DEFS.map((report) => [report.agentId, report])
)

export const TRADING_AGENT_REPORT_CARD_BY_SLOT = Object.fromEntries(
  TRADING_AGENT_REPORT_CARD_DEFS.map((report) => [report.reportSlot, report])
)

const getNestedPathValue = (source, path) => {
  if (!source || !Array.isArray(path) || path.length === 0) return undefined
  let cursor = source
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

export function getTradingAgentRawStateReportValues(rawState = {}, agentId = '') {
  const reportDef = TRADING_AGENT_REPORT_CARD_BY_AGENT[agentId]
  if (!reportDef) return []
  return (reportDef.rawStatePaths || [])
    .map((path) => getNestedPathValue(rawState, path))
    .filter((value) => value != null)
}

export const TRADING_AGENT_WORKFLOW_STEP_BY_KEY = Object.fromEntries(
  TRADING_AGENT_WORKFLOW_STEPS.map((step) => [step.key, step])
)

export const TRADING_AGENT_WORKFLOW_STEP_BY_NUMBER = Object.fromEntries(
  TRADING_AGENT_WORKFLOW_STEPS.map((step) => [step.step, step])
)

export const TRADING_AGENT_REPORT_KEY_BY_STEP = Object.fromEntries(
  TRADING_AGENT_WORKFLOW_STEPS.map((step) => [step.key, step.reportKey])
)

export const TRADING_AGENT_REPORT_KEY_BY_AGENT = TRADING_AGENT_WORKFLOW_STEPS.reduce((map, step) => {
  step.agents.forEach((agentId) => {
    map[agentId] = step.reportKey
  })
  return map
}, {})

export const TRADING_AGENT_REPORT_SECTION_BY_AGENT = TRADING_AGENT_REPORT_SECTIONS.reduce((map, section) => {
  section.agents.forEach((agentId) => {
    map[agentId] = section.key
  })
  return map
}, {})

export const TRADING_AGENT_STEP_NUM_BY_AGENT = TRADING_AGENT_WORKFLOW_STEPS.reduce((map, step) => {
  step.agents.forEach((agentId) => {
    map[agentId] = step.step
  })
  return map
}, {})

export const TRADING_AGENT_SCENE_MAP = {
  market_analyst: 'STEP_1_ANALYSTS',
  social_analyst: 'STEP_1_ANALYSTS',
  news_analyst: 'STEP_1_ANALYSTS',
  fundamentals_analyst: 'STEP_1_ANALYSTS',
  bull_researcher: 'STEP_2_RESEARCH',
  bear_researcher: 'STEP_2_RESEARCH',
  research_manager: 'STEP_2_RESEARCH',
  trader: 'STEP_3_TRADER',
  aggressive_analyst: 'STEP_4_RISK',
  conservative_analyst: 'STEP_4_RISK',
  neutral_analyst: 'STEP_4_RISK',
  risk_judge: 'STEP_5_PORTFOLIO',
}

export const TRADING_AGENT_NAME_MAP = TRADING_AGENT_DEFS.reduce((map, agent) => {
  map[agent.id] = agent.name
  map[agent.name] = agent.name
  map[agent.shortLabel] = agent.name
  agent.aliases.forEach((alias) => {
    map[alias] = agent.name
  })
  return map
}, {})

export const TRADING_AGENT_STATIONS = TRADING_AGENT_DEFS.reduce((map, agent) => {
  map[agent.name] = {
    station: agent.station,
    tile: STATION_TILE_MAP[agent.station] || 2,
  }
  return map
}, {})

export function normalizeTradingAgentName(value) {
  if (!value) return value
  return TRADING_AGENT_NAME_MAP[value] || TRADING_AGENT_NAME_MAP[String(value).replace(/_/g, ' ')] || value
}

export function normalizeTradingAgentId(value) {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null
  const lower = raw.toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')

  for (const agent of TRADING_AGENT_DEFS) {
    if (lower === agent.id) return agent.id
    if (lower === agent.name.toLowerCase().replace(/\s+/g, '_')) return agent.id
    if (lower === agent.shortLabel.toLowerCase().replace(/\s+/g, '_')) return agent.id
    if (agent.aliases.some((alias) => lower === String(alias).toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_'))) {
      return agent.id
    }
  }

  return null
}

export function buildTradingAgentsObject() {
  return TRADING_AGENT_DEFS.reduce((map, agent) => {
    map[agent.name] = {
      position: agent.position,
      personality: agent.personality,
      color: agent.color,
      shortName: agent.id,
    }
    return map
  }, {})
}

