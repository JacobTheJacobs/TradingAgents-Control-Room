// Trading Floor Constants
import {
  TRADING_AGENT_NAME_MAP as BASE_TRADING_AGENT_NAME_MAP,
  TRADING_AGENT_STATIONS,
  buildTradingAgentsObject,
} from '../config/tradingAgentsRoster'

export const TILE_SIZE = 32

// Canonical TradingAgents roster - the canvas source of truth.
export let AGENTS = buildTradingAgentsObject()

export const AGENT_FALLBACK_LIST = Object.keys(AGENTS)

// Admin/Scene Director Mappings
export const EMOTE_CODE_MAP = {
  'IDLE': 0, 'HAPPY': 1, 'SAD': 2, 'ANGRY': 3, 'SURPRISED': 4,
  'THINKING': 5, 'SLEEPING': 6, 'WORKING': 7, 'CELEBRATING': 8
}

export const STATION_CODE_MAP = {
  'NONE': 0, 'DESK': 1, 'SCANNER': 2, 'TV': 3, 'COOLER': 4,
  'TABLE': 5, 'NEWSSTAND': 6, 'WINDOW': 7, 'TICKER': 8
}

export const PATH_CODE_MAP = {
  'STAY': 0, 'WANDER': 1, 'APPROACH': 2, 'LEAVE': 3, 'FOLLOW': 4
}

// Room map with scanner station for Scout
export const ROOM_MAP = [
  [1, 12, 12, 1, 12, 12, 1, 12, 12, 9, 12, 12, 1, 12, 12, 1, 1, 1, 1, 1],
  [1, 3, 3, 3, 1, 3, 3, 3, 0, 0, 13, 0, 0, 13, 0,11, 11, 0, 0, 1], 
  [1, 0, 0, 0, 0, 0, 0, 0, 6, 6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 2, 2, 2, 0, 0, 2, 2, 2, 0, 0, 0, 0, 2, 2, 2, 0, 0, 1],
  [1, 0, 0, 0, 13, 0, 0, 0, 6, 6, 6, 0, 0, 0, 0, 13, 0, 0, 0, 1],
  [1, 0, 6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 6, 0, 1],
  [1, 0, 6, 6, 0, 2, 2, 2, 0, 0, 0, 2, 2, 2, 0, 0, 6, 6, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 15, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 2, 2, 2, 0, 0, 0, 15, 15, 15, 0, 0, 0, 2, 2, 2, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 6, 15, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, 0, 0, 1],  // SCANNER at col 18
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
]

export const TILE_TYPES = {
  FLOOR: 0, WALL: 1, DESK: 2, TICKER: 3, COOLER: 4, NEWSSTAND: 5,
  RUG: 6, CAT: 7, MONEY: 8, DOOR: 9, CABINET: 10, TV: 11, WINDOW: 12, PLANT: 13, SCANNER: 14, TABLE: 15
}

// Agent station assignments based on the canonical TradingAgents roster.
export const AGENT_STATIONS = TRADING_AGENT_STATIONS

// Tool to station mapping
export const TOOL_STATIONS = {
  "web_search": "desk",
  "read_file": "desk",
  "technical_analysis": "scanner",
  "fundamental_analysis": "desk",
  "news_sentiment": "tv",
  "system_run": "desk",
  "web_fetch": "scanner",
  "write_to_file": "desk",
  "oracle_synthesis": "desk",
  "scout_scan": "scanner",
  "debate": "cooler",
  "pre_mortem": "desk",
  "war_room": "desk",
  "regime": "scanner",
}

// Schedule phase info
export const SCHEDULE_PHASES = {
  'pre_market': { emoji: '🌅', label: 'Pre-Market Hunt', description: 'LLM Active - Frantic Research' },
  'open': { emoji: '🏃', label: 'Market Open', description: 'High Adrenaline Execution' },
  'midday': { emoji: '☕', label: 'Midday Lull', description: 'Water Cooler Chatter' },
  'power_hour': { emoji: '⚡', label: 'Power Hour', description: 'Liquidation Mode' },
  'after_hours': { emoji: '🌙', label: 'After Hours', description: 'Night Shift R&D' }
}

// Station to tile type mapping
export const STATION_TILE_MAP = {
  'scanner': TILE_TYPES.SCANNER,
  'desk': TILE_TYPES.DESK,
  'tv': TILE_TYPES.TV,
  'cooler': TILE_TYPES.COOLER,
  'table': TILE_TYPES.TABLE,
  'newsstand': TILE_TYPES.NEWSSTAND,
  'window': TILE_TYPES.WINDOW,
  'ticker': TILE_TYPES.TICKER,
  'center': TILE_TYPES.TABLE,
  'tier3_whale': TILE_TYPES.TABLE,
}

// Pre-calculated gathering spots for gossip scenes
// These are walkable positions near the COOLER and TABLE
// COOLER is at (c=18, r=12), TABLE is at (c=9, r=7)
export const GATHER_SPOTS = {
  cooler: [
    { c: 18, r: 11 }, { c: 18, r: 13 }, { c: 17, r: 12 }, { c: 17, r: 11 }, { c: 17, r: 13 },
    { c: 16, r: 12 }, { c: 16, r: 11 }, { c: 16, r: 13 }, { c: 17, r: 10 }, { c: 18, r: 10 },
    { c: 19, r: 11 }, { c: 19, r: 12 }, { c: 19, r: 13 }, { c: 16, r: 10 }, { c: 15, r: 11 },
    { c: 15, r: 12 }, { c: 15, r: 13 }, { c: 17, r: 14 }, { c: 18, r: 14 }, { c: 19, r: 14 }
  ],
  table: [
    { c: 7, r: 7 }, { c: 8, r: 7 }, { c: 10, r: 7 }, { c: 11, r: 7 }, // Top 4
    { c: 11, r: 8 }, { c: 11, r: 10 }, // Right 2
    { c: 11, r: 11 }, { c: 10, r: 11 }, { c: 8, r: 11 }, { c: 7, r: 11 }, // Bottom 4
    { c: 7, r: 10 }, { c: 7, r: 8 }, // Left 2
    { c: 9, r: 7 }, { c: 11, r: 9 }, { c: 9, r: 11 }, { c: 7, r: 9 } // Centers (backups for >12 agents)
  ],
  center: [
    { c: 7, r: 7 }, { c: 8, r: 7 }, { c: 9, r: 7 }, { c: 10, r: 7 }, { c: 11, r: 7 },
    { c: 11, r: 8 }, { c: 11, r: 9 }, { c: 11, r: 10 },
    { c: 11, r: 11 }, { c: 10, r: 11 }, { c: 9, r: 11 }, { c: 8, r: 11 }, { c: 7, r: 11 },
    { c: 7, r: 10 }, { c: 7, r: 9 }, { c: 7, r: 8 }
  ],
  scanner: [
    { c: 17, r: 11 }, { c: 18, r: 10 }, { c: 19, r: 11 }, { c: 17, r: 12 }, { c: 19, r: 12 },
    { c: 16, r: 11 }, { c: 16, r: 10 }, { c: 15, r: 11 }, { c: 17, r: 10 }, { c: 19, r: 10 },
    { c: 18, r: 9 }, { c: 17, r: 9 }, { c: 16, r: 9 }, { c: 19, r: 9 }, { c: 15, r: 10 }
  ],
  tv: [
    { c: 15, r: 2 }, { c: 16, r: 2 }, { c: 14, r: 2 }, { c: 17, r: 2 }, { c: 18, r: 2 },
    { c: 15, r: 3 }, { c: 16, r: 3 }, { c: 14, r: 3 }, { c: 17, r: 3 }, { c: 18, r: 3 },
    { c: 15, r: 4 }, { c: 16, r: 4 }, { c: 14, r: 4 }, { c: 17, r: 4 }, { c: 13, r: 2 }
  ],
  ticker: [
    { c: 1, r: 2 }, { c: 2, r: 2 }, { c: 3, r: 2 }, { c: 5, r: 2 }, { c: 6, r: 2 }, { c: 7, r: 2 },
    { c: 8, r: 2 }, { c: 0, r: 2 }, { c: 4, r: 2 }, { c: 9, r: 2 }, { c: 10, r: 2 }, { c: 11, r: 2 }
  ],
  newsstand: [
    { c: 3, r: 11 }, { c: 5, r: 11 }, { c: 4, r: 12 }, { c: 2, r: 11 }, { c: 6, r: 11 },
    { c: 3, r: 12 }, { c: 5, r: 12 }, { c: 4, r: 10 }, { c: 3, r: 10 }, { c: 5, r: 10 }
  ],
  window: [
    { c: 1, r: 1 }, { c: 2, r: 1 }, { c: 4, r: 1 }, { c: 5, r: 1 }, { c: 7, r: 1 }, { c: 8, r: 1 },
    { c: 0, r: 1 }, { c: 3, r: 1 }, { c: 6, r: 1 }, { c: 9, r: 1 }, { c: 10, r: 1 }, { c: 11, r: 1 }
  ],
  desk: [
    // Top Row Desks (seats at row 4)
    { c: 2, r: 4 }, { c: 3, r: 4 }, { c: 4, r: 4 },     // Left Top
    { c: 7, r: 4 }, { c: 8, r: 4 }, { c: 9, r: 4 },     // Middle Top
    { c: 14, r: 4 }, { c: 15, r: 4 }, { c: 16, r: 4 },  // Right Top
    // Bottom Row Desks (seats at row 10)
    { c: 2, r: 10 }, { c: 3, r: 10 }, { c: 4, r: 10 },  // Left Bottom
    { c: 14, r: 10 }, { c: 15, r: 10 }, { c: 16, r: 10 } // Right Bottom
  ]
}


// Idle animation categories by schedule phase
export const IDLE_BY_SCHEDULE = {
  'pre_market': [
    'coffee_sip', 'coffee_refill', 'stretch', 'yawn',
    'chin_scratch', 'deep_thought', 'notebook_write',
    'fix_tie', 'check_watch', 'screen_stare'
  ],
  'open': [
    'screen_stare', 'screen_lean', 'ticker_watch', 'multi_screen',
    'pen_tap', 'fist_pump', 'victory_pose', 'pace_fast',
    'check_watch', 'head_shake', 'thumbs_up'
  ],
  'midday': [
    'coffee_sip', 'gossip', 'whisper', 'laugh', 'nod_agree',
    'wander', 'snack', 'lunch', 'feet_up', 'spin_chair',
    'phone_check', 'phone_text', 'paper_shuffle'
  ],
  'power_hour': [
    'screen_stare', 'ticker_watch', 'pen_tap',
    'energy_drink', 'pace_fast', 'fist_pump',
    'check_watch', 'head_shake'
  ],
  'after_hours': [
    'sleep', 'nap_head_down', 'yawn', 'headphones_on',
    'head_bob', 'feet_up', 'lean_back_chair', 'wander',
    'phone_check', 'look_out_window', 'stretch'
  ],
  'weekend': [
    'sleep', 'nap_head_down', 'headphones_on',
    'look_out_window', 'stretch', 'yawn'
  ]
}

// Animation duration ranges (in ms)
export const ANIMATION_DURATIONS = {
  'sleep': [5000, 15000],
  'nap_head_down': [3000, 8000],
  'yawn': [1500, 2500],
  'stretch': [2000, 3000],
  'coffee_sip': [2000, 4000],
  'coffee_refill': [3000, 5000],
  'energy_drink': [2000, 3000],
  'chin_scratch': [2000, 4000],
  'head_scratch': [1500, 3000],
  'glasses_adjust': [1000, 2000],
  'glasses_clean': [3000, 5000],
  'pen_tap': [2000, 5000],
  'notebook_write': [3000, 8000],
  'deep_thought': [4000, 8000],
  'screen_stare': [3000, 7000],
  'screen_lean': [2000, 4000],
  'ticker_watch': [5000, 15000],
  'multi_screen': [3000, 6000],
  'eye_roll': [1000, 2000],
  'facepalm': [2000, 4000],
  'shrug': [1500, 2500],
  'head_shake': [1500, 3000],
  'thumbs_up': [1000, 2000],
  'fist_pump': [1000, 2000],
  'victory_pose': [2000, 4000],
  'phone_check': [2000, 5000],
  'phone_text': [3000, 8000],
  'phone_call': [5000, 15000],
  'whisper': [2000, 5000],
  'gossip': [5000, 15000],
  'laugh': [2000, 4000],
  'nod_agree': [1500, 3000],
  'argue': [3000, 8000],
  'high_five': [1000, 2000],
  'handshake': [2000, 3000],
  'pace': [5000, 15000],
  'wander': [10000, 30000],
  'pace_fast': [3000, 8000],
  'spin_chair': [2000, 4000],
  'lean_back_chair': [3000, 8000],
  'snack': [3000, 8000],
  'lunch': [10000, 20000],
  'water_bottle': [2000, 4000],
  'feet_up': [5000, 15000],
  'headphones_on': [5000, 20000],
  'head_bob': [3000, 8000],
  'paper_shuffle': [2000, 5000],
  'paper_read': [5000, 15000],
  'file_away': [3000, 5000],
  'check_watch': [1000, 2000],
  'look_out_window': [5000, 15000],
  'fix_tie': [1500, 3000],
  'dust_off': [1500, 2500],
  'stretch_arms': [2000, 4000],
  'neck_crack': [1500, 2500],
  'default': [2000, 5000]
}

// Error state animations
export const ERROR_ANIMATIONS = {
  'api_timeout': 'facepalm',
  'llm_error': 'head_scratch',
  'data_source_down': 'shrug',
  'no_internet': 'sleep',
  'trade_failed': 'head_shake',
  'default': 'eye_roll'
}

// Canonical TradingAgents alias map shared by canvas/showrunner/dialogue surfaces.
export let AGENT_NAME_MAP = { ...BASE_TRADING_AGENT_NAME_MAP }


/**
 * Resolve short agent name to full agent name
 * @param {string} shortName - Short name from backend (e.g., "Warren", "Risk", "Contrarian")
 * @returns {string} Full agent name for lookup in AGENTS constant
 */
export function resolveAgentName(shortName) {
  return AGENT_NAME_MAP[shortName] || AGENT_NAME_MAP[String(shortName).replace(/_/g, ' ')] || shortName
}

/**
 * Fetch agent configuration from backend API
 * Merges personality config with canvas config
 * @returns {Promise<Object>} Agent configuration object keyed by displayName
 */
export async function fetchAgentsFromAPI() {
  try {
    const res = await fetch('/trading-floor/agents/canvas-config')
    if (!res.ok) {
      console.warn('Failed to fetch agents from API, using static config')
      return null
    }
    const data = await res.json()

    // Convert from short-name keys to displayName keys (for canvas compatibility)
    const agents = {}
    for (const [shortName, cfg] of Object.entries(data.agents || {})) {
      if (cfg.active) {
        agents[cfg.displayName] = {
          position: cfg.position,
          personality: cfg.personality,
          color: cfg.color,
          shortName: shortName  // Keep reference to short name
        }
      }
    }
    return agents
  } catch (err) {
    console.warn('Error fetching agents from API:', err)
    return null
  }
}

/**
 * Build AGENT_NAME_MAP dynamically from API response
 * @param {Object} apiAgents - Response from /agents/canvas-config
 * @returns {Object} Name mapping object
 */
export function buildAgentNameMap(apiAgents) {
  const map = { ...BASE_TRADING_AGENT_NAME_MAP }
  for (const [shortName, cfg] of Object.entries(apiAgents || {})) {
    map[shortName] = cfg.displayName
    map[cfg.displayName] = cfg.displayName
    if (cfg.shortLabel) {
      map[cfg.shortLabel] = cfg.displayName
    }
    if (Array.isArray(cfg.aliases)) {
      cfg.aliases.forEach(alias => {
        map[alias] = cfg.displayName
      })
    }
  }
  return map
}

/**
 * Get merged agent configuration (API first, fallback to static)
 * @returns {Promise<Object>} Agent configuration
 */
export async function getAgents() {
  const apiAgents = await fetchAgentsFromAPI()
  return apiAgents || AGENTS
}

/**
 * Update the global AGENTS object
 * @param {Object} newAgents 
 */
export function setGlobalAgents(newAgents) {
  if (newAgents && Object.keys(newAgents).length > 0) {
    AGENTS = newAgents
  }
}

/**
 * Update the global AGENT_NAME_MAP object
 * @param {Object} newMap 
 */
export function setGlobalAgentNameMap(newMap) {
  if (newMap && Object.keys(newMap).length > 0) {
    AGENT_NAME_MAP = newMap
  }
}
