/**
 * Idle animation definitions
 * 50+ idle behaviors triggered by schedule phase, location, or random events
 */

// ================================================================
// 50+ IDLE ANIMATION DEFINITIONS
// ================================================================

export const IDLE_ANIMATIONS = {
  // SLEEP/REST ANIMATIONS (Night Shift)
  sleep: {
    name: 'sleep',
    duration: [3000, 8000],
    schedulePhases: ['after_hours', 'weekend'],
    tint: 0x666666,
    description: 'Agent sleeps at desk',
  },
  nap_head_down: {
    name: 'nap_head_down',
    duration: [2000, 5000],
    schedulePhases: ['after_hours'],
    description: 'Quick nap with head on desk',
  },
  yawn: {
    name: 'yawn',
    duration: [1500, 2500],
    schedulePhases: ['after_hours', 'pre_market'],
    description: 'Big yawn',
  },
  stretch: {
    name: 'stretch',
    duration: [2000, 3000],
    schedulePhases: ['all'],
    description: 'Stretch arms above head',
  },

  // COFFEE/CAFFEINE ANIMATIONS
  coffee_sip: {
    name: 'coffee_sip',
    duration: [2000, 4000],
    schedulePhases: ['pre_market', 'open', 'after_hours'],
    station: 'cooler',
    description: 'Sip coffee contemplatively',
  },
  coffee_refill: {
    name: 'coffee_refill',
    duration: [3000, 5000],
    schedulePhases: ['all'],
    station: 'cooler',
    description: 'Walk to cooler, refill coffee',
  },
  energy_drink: {
    name: 'energy_drink',
    duration: [2000, 3000],
    schedulePhases: ['pre_market', 'power_hour'],
    description: 'Chug energy drink',
  },

  // THINKING/RESEARCH ANIMATIONS
  chin_scratch: {
    name: 'chin_scratch',
    duration: [2000, 4000],
    schedulePhases: ['pre_market', 'midday'],
    station: 'desk',
    description: 'Scratch chin thoughtfully',
  },
  head_scratch: {
    name: 'head_scratch',
    duration: [1500, 3000],
    schedulePhases: ['all'],
    description: 'Scratch head in confusion',
  },
  glasses_adjust: {
    name: 'glasses_adjust',
    duration: [1000, 2000],
    schedulePhases: ['all'],
    description: 'Adjust glasses',
  },
  glasses_clean: {
    name: 'glasses_clean',
    duration: [3000, 5000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'Remove and clean glasses',
  },
  pen_tap: {
    name: 'pen_tap',
    duration: [2000, 5000],
    schedulePhases: ['all'],
    station: 'desk',
    description: 'Tap pen on desk rhythmically',
  },
  notebook_write: {
    name: 'notebook_write',
    duration: [3000, 8000],
    schedulePhases: ['pre_market', 'midday'],
    station: 'desk',
    description: 'Write in notebook',
  },
  deep_thought: {
    name: 'deep_thought',
    duration: [4000, 8000],
    schedulePhases: ['pre_market', 'midday'],
    description: 'Deep thinking pose',
  },

  // SCREEN WATCHING ANIMATIONS
  screen_stare: {
    name: 'screen_stare',
    duration: [3000, 7000],
    schedulePhases: ['open', 'power_hour'],
    station: 'desk',
    description: 'Intently stare at screen',
  },
  screen_lean: {
    name: 'screen_lean',
    duration: [2000, 4000],
    schedulePhases: ['open', 'power_hour'],
    station: 'desk',
    description: 'Lean toward screen',
  },
  ticker_watch: {
    name: 'ticker_watch',
    duration: [5000, 15000],
    schedulePhases: ['open', 'power_hour'],
    station: 'scanner',
    description: 'Watch ticker tape',
  },
  multi_screen: {
    name: 'multi_screen',
    duration: [3000, 6000],
    schedulePhases: ['open', 'pre_market'],
    station: 'desk',
    description: 'Look between multiple screens',
  },

  // EMOTIONAL REACTIONS
  eye_roll: {
    name: 'eye_roll',
    duration: [1000, 2000],
    schedulePhases: ['all'],
    description: 'Roll eyes',
  },
  facepalm: {
    name: 'facepalm',
    duration: [2000, 4000],
    schedulePhases: ['all'],
    description: 'Facepalm in frustration',
  },
  shrug: {
    name: 'shrug',
    duration: [1500, 2500],
    schedulePhases: ['all'],
    description: 'Shrug shoulders',
  },
  head_shake: {
    name: 'head_shake',
    duration: [1500, 3000],
    schedulePhases: ['all'],
    description: 'Shake head in disappointment',
  },
  thumbs_up: {
    name: 'thumbs_up',
    duration: [1000, 2000],
    schedulePhases: ['all'],
    description: 'Give thumbs up',
  },
  fist_pump: {
    name: 'fist_pump',
    duration: [1000, 2000],
    schedulePhases: ['open', 'power_hour'],
    description: 'Small fist pump',
  },
  victory_pose: {
    name: 'victory_pose',
    duration: [2000, 4000],
    schedulePhases: ['open', 'power_hour'],
    description: 'Victory pose after win',
  },

  // PHONE/COMMUNICATION
  phone_check: {
    name: 'phone_check',
    duration: [2000, 5000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'Check phone',
  },
  phone_text: {
    name: 'phone_text',
    duration: [3000, 8000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'Text on phone',
  },
  phone_call: {
    name: 'phone_call',
    duration: [5000, 15000],
    schedulePhases: ['all'],
    description: 'Talk on phone',
  },

  // SOCIAL/GOSSIP ANIMATIONS
  whisper: {
    name: 'whisper',
    duration: [2000, 5000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'cooler',
    description: 'Whisper to nearby agent',
  },
  gossip: {
    name: 'gossip',
    duration: [5000, 15000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'cooler',
    description: 'Gossip at water cooler',
  },
  laugh: {
    name: 'laugh',
    duration: [2000, 4000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'cooler',
    description: 'Laugh at joke',
  },
  nod_agree: {
    name: 'nod_agree',
    duration: [1500, 3000],
    schedulePhases: ['all'],
    description: 'Nod in agreement',
  },
  argue: {
    name: 'argue',
    duration: [3000, 8000],
    schedulePhases: ['pre_market', 'midday'],
    station: 'table',
    description: 'Argue with another agent',
  },
  high_five: {
    name: 'high_five',
    duration: [1000, 2000],
    schedulePhases: ['open', 'power_hour'],
    description: 'High five another agent',
  },
  handshake: {
    name: 'handshake',
    duration: [2000, 3000],
    schedulePhases: ['pre_market'],
    description: 'Shake hands',
  },

  // MOVEMENT ANIMATIONS
  pace: {
    name: 'pace',
    duration: [5000, 15000],
    schedulePhases: ['pre_market', 'open'],
    description: 'Pace back and forth',
  },
  wander: {
    name: 'wander',
    duration: [10000, 30000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'Wander around room',
  },
  pace_fast: {
    name: 'pace_fast',
    duration: [3000, 8000],
    schedulePhases: ['open', 'power_hour'],
    description: 'Fast anxious pacing',
  },
  spin_chair: {
    name: 'spin_chair',
    duration: [2000, 4000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'desk',
    description: 'Spin in office chair',
  },
  lean_back_chair: {
    name: 'lean_back_chair',
    duration: [3000, 8000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'desk',
    description: 'Lean back in chair',
  },

  // EATING/DRINKING
  snack: {
    name: 'snack',
    duration: [3000, 8000],
    schedulePhases: ['midday'],
    station: 'desk',
    description: 'Eat a snack',
  },
  lunch: {
    name: 'lunch',
    duration: [10000, 20000],
    schedulePhases: ['midday'],
    description: 'Eat lunch at desk',
  },
  water_bottle: {
    name: 'water_bottle',
    duration: [2000, 4000],
    schedulePhases: ['all'],
    description: 'Drink from water bottle',
  },

  // RELAXATION
  feet_up: {
    name: 'feet_up',
    duration: [5000, 15000],
    schedulePhases: ['midday', 'after_hours'],
    station: 'desk',
    description: 'Put feet up on desk',
  },
  headphones_on: {
    name: 'headphones_on',
    duration: [5000, 20000],
    schedulePhases: ['after_hours'],
    description: 'Put on headphones, listen to music',
  },
  head_bob: {
    name: 'head_bob',
    duration: [3000, 8000],
    schedulePhases: ['after_hours'],
    description: 'Bob head to music',
  },

  // PAPERWORK
  paper_shuffle: {
    name: 'paper_shuffle',
    duration: [2000, 5000],
    schedulePhases: ['pre_market', 'midday'],
    station: 'desk',
    description: 'Shuffle papers',
  },
  paper_read: {
    name: 'paper_read',
    duration: [5000, 15000],
    schedulePhases: ['pre_market', 'midday'],
    station: 'desk',
    description: 'Read physical document',
  },
  file_away: {
    name: 'file_away',
    duration: [3000, 5000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'File away documents',
  },

  // MISC IDLE
  check_watch: {
    name: 'check_watch',
    duration: [1000, 2000],
    schedulePhases: ['all'],
    description: 'Check watch',
  },
  look_out_window: {
    name: 'look_out_window',
    duration: [5000, 15000],
    schedulePhases: ['midday', 'after_hours'],
    description: 'Look out window contemplatively',
  },
  fix_tie: {
    name: 'fix_tie',
    duration: [1500, 3000],
    schedulePhases: ['pre_market'],
    description: 'Adjust tie',
  },
  check_shoes: {
    name: 'check_shoes',
    duration: [2000, 3000],
    schedulePhases: ['pre_market'],
    description: 'Look down at shoes',
  },
  dust_off: {
    name: 'dust_off',
    duration: [1500, 2500],
    schedulePhases: ['all'],
    description: 'Dust off shoulders',
  },
  stretch_arms: {
    name: 'stretch_arms',
    duration: [2000, 4000],
    schedulePhases: ['all'],
    description: 'Stretch arms out',
  },
  neck_crack: {
    name: 'neck_crack',
    duration: [1500, 2500],
    schedulePhases: ['all'],
    description: 'Crack neck',
  },
}

// Animation groups by category
export const IDLE_CATEGORIES = {
  sleep: ['sleep', 'nap_head_down', 'yawn'],
  caffeine: ['coffee_sip', 'coffee_refill', 'energy_drink'],
  thinking: ['chin_scratch', 'head_scratch', 'glasses_adjust', 'glasses_clean', 'deep_thought'],
  focus: ['screen_stare', 'screen_lean', 'ticker_watch', 'multi_screen', 'pen_tap'],
  emotion: ['eye_roll', 'facepalm', 'shrug', 'head_shake', 'thumbs_up', 'fist_pump', 'victory_pose'],
  social: ['whisper', 'gossip', 'laugh', 'nod_agree', 'argue', 'high_five', 'handshake'],
  movement: ['pace', 'wander', 'pace_fast', 'spin_chair', 'lean_back_chair'],
  eating: ['snack', 'lunch', 'water_bottle'],
  relax: ['feet_up', 'headphones_on', 'head_bob', 'stretch'],
  paperwork: ['paper_shuffle', 'paper_read', 'file_away', 'notebook_write'],
  misc: ['check_watch', 'look_out_window', 'fix_tie', 'dust_off', 'stretch_arms', 'neck_crack'],
}

// Schedule phase to idle category mapping
export const SCHEDULE_IDLE_MAP = {
  pre_market: ['caffeine', 'thinking', 'focus', 'paperwork'],
  open: ['focus', 'emotion', 'movement'],
  midday: ['social', 'eating', 'relax', 'paperwork'],
  power_hour: ['focus', 'emotion', 'movement'],
  after_hours: ['sleep', 'relax', 'social', 'eating'],
  weekend: ['sleep', 'relax', 'misc'],
}

/**
 * Get random idle animation for a schedule phase
 * @param {string} schedulePhase - The current schedule phase
 * @param {string|null} station - Optional station filter
 * @returns {Object} Animation configuration
 */
export function getRandomIdleAnimation(schedulePhase, station = null) {
  const categories = SCHEDULE_IDLE_MAP[schedulePhase] || ['misc']
  const category = categories[Math.floor(Math.random() * categories.length)]
  const animations = IDLE_CATEGORIES[category] || IDLE_CATEGORIES.misc

  // Filter by station if provided
  const validAnimations = animations.filter(animName => {
    const anim = IDLE_ANIMATIONS[animName]
    return !station || !anim.station || anim.station === station
  })

  const animName = validAnimations[Math.floor(Math.random() * validAnimations.length)] || 'stretch'
  return IDLE_ANIMATIONS[animName]
}

/**
 * Get animation duration (random within range)
 * @param {Object} animation - Animation configuration
 * @returns {number} Duration in milliseconds
 */
export function getAnimationDuration(animation) {
  const [min, max] = animation.duration
  return min + Math.random() * (max - min)
}
