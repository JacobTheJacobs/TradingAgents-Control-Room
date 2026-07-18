/**
 * Phase-Specific Sprite Behaviors
 * 
 * Defines how agents should behave during different market phases:
 * - Pre-market: Frantic research mode
 * - Open: High adrenaline execution
 * - Midday: Relaxed water cooler chatter
 * - Power Hour: Urgent liquidation focus
 * - After Hours: Half asleep, R&D mode
 */

export const PHASE_BEHAVIORS = {
  pre_market: {
    // Frantic research mode - agents rushing around
    animations: ['web_search', 'read_file', 'web_fetch'],
    positions: ['desk', 'scanner'],
    speed: 1.5,         // Frantic movement
    gossipFrequency: 0, // No gossip during active LLM
    agentBehavior: {
      moveChance: 0.3,   // Higher chance to move
      idleTime: 2000,    // Short idle periods
      targetStations: ['desk', 'scanner'],
    },
    lighting: {
      ambient: 0.8,
      tint: 0xFFF5E6,   // Warm sunrise tint
      shadowStrength: 0.3,
    },
  },
  
  open: {
    // High adrenaline execution - focused at desks
    animations: ['system_run', 'web_fetch'],
    positions: ['desk'],
    speed: 1.0,         // Focused, deliberate
    gossipFrequency: 0, // No gossip during execution
    agentBehavior: {
      moveChance: 0.1,   // Low movement, stay at desks
      idleTime: 5000,    // Longer focus periods
      targetStations: ['desk'],
    },
    lighting: {
      ambient: 1.0,      // Bright fluorescent
      tint: 0xFFFFFF,    // Neutral white
      shadowStrength: 0.5,
    },
  },
  
  midday: {
    // Watercooler mode - relaxed, chatty
    animations: ['idle', 'communicating'],
    positions: ['cooler', 'desk'],
    speed: 0.5,         // Slow, relaxed
    gossipFrequency: 20000, // Every 20 seconds
    agentBehavior: {
      moveChance: 0.4,   // Wander around
      idleTime: 8000,    // Long idle periods
      targetStations: ['cooler', 'desk', 'tv'],
    },
    lighting: {
      ambient: 0.7,
      tint: 0xF0F8FF,    // Slight blue tint
      shadowStrength: 0.4,
    },
  },
  
  power_hour: {
    // Liquidation focus - urgent but controlled
    animations: ['write_to_file', 'system_run'],
    positions: ['desk'],
    speed: 1.2,         // Urgent movement
    gossipFrequency: 60000, // Every 60 seconds (minimal)
    agentBehavior: {
      moveChance: 0.2,   // Stay mostly at desks
      idleTime: 3000,    // Short focus periods
      targetStations: ['desk'],
    },
    lighting: {
      ambient: 0.9,
      tint: 0xFFE4E1,    // Red accent for urgency
      shadowStrength: 0.5,
    },
  },
  
  after_hours: {
    // Night shift - half asleep, R&D mode
    animations: ['idle', 'sleep'],
    positions: ['sleep', 'desk'],
    speed: 0.3,         // Very slow, sleepy
    gossipFrequency: 30000, // Every 30 seconds
    agentBehavior: {
      moveChance: 0.1,   // Minimal movement
      idleTime: 15000,   // Long idle/sleep periods
      targetStations: ['desk', 'cooler'],
      sleepRatio: 0.5,   // 50% of agents sleeping
    },
    lighting: {
      ambient: 0.4,      // Dark mode
      tint: 0x4169E1,    // Blue/purple Lofi vibes
      shadowStrength: 0.8,
    },
  },
  
  weekend: {
    // Weekend - mostly dormant
    animations: ['idle', 'sleep'],
    positions: ['sleep'],
    speed: 0.2,         // Very slow
    gossipFrequency: 45000, // Every 45 seconds
    agentBehavior: {
      moveChance: 0.05,  // Almost no movement
      idleTime: 30000,   // Very long idle
      targetStations: ['sleep', 'desk'],
      sleepRatio: 0.8,   // 80% of agents sleeping
    },
    lighting: {
      ambient: 0.3,      // Very dark
      tint: 0x483D8B,    // Deep purple
      shadowStrength: 0.9,
    },
  },
}


/**
 * Agent personality modifiers - affects how each agent behaves
 */
export const PERSONALITY_MODIFIERS = {
  // Fear & Caution
  the_paranoid: {
    movePattern: 'erratic',
    idleAnimation: 'nervous',
    speedModifier: 1.2,  // More anxious
  },
  the_skeptic: {
    movePattern: 'careful',
    idleAnimation: 'thinking',
    speedModifier: 0.9,
  },
  
  // Greed & Opportunity
  the_gambler: {
    movePattern: 'aggressive',
    idleAnimation: 'excited',
    speedModifier: 1.4,  // High energy
  },
  the_fomo: {
    movePattern: 'frantic',
    idleAnimation: 'anxious',
    speedModifier: 1.3,
  },
  
  // Logic & Analysis
  the_analyst: {
    movePattern: 'deliberate',
    idleAnimation: 'focused',
    speedModifier: 0.8,  // Slow, methodical
  },
  the_historian: {
    movePattern: 'slow',
    idleAnimation: 'reading',
    speedModifier: 0.7,
  },
  
  // Emotion & Intuition
  the_gut: {
    movePattern: 'random',
    idleAnimation: 'pondering',
    speedModifier: 1.0,
  },
  the_optimist: {
    movePattern: 'relaxed',
    idleAnimation: 'happy',
    speedModifier: 0.9,
  },
  
  // Contrarian & Edge
  the_contrarian: {
    movePattern: 'opposite',
    idleAnimation: 'smirking',
    speedModifier: 1.1,
  },
  the_insider: {
    movePattern: 'sneaky',
    idleAnimation: 'watching',
    speedModifier: 0.85,
  },
  
  // Special agents
  the_oracle: {
    movePattern: 'stationary',  // Oracle stays at desk
    idleAnimation: 'meditating',
    speedModifier: 0.5,
  },
  the_intern: {
    movePattern: 'busy',
    idleAnimation: 'working',
    speedModifier: 1.5,  // Always running around
  },
  scout: {
    movePattern: 'patrol',
    idleAnimation: 'scanning',
    speedModifier: 1.3,  // Active scanner
  },
}


/**
 * Get behavior config for a specific phase
 */
export function getPhaseBehavior(phase) {
  return PHASE_BEHAVIORS[phase] || PHASE_BEHAVIORS.midday
}


/**
 * Get personality modifier for an agent
 */
export function getPersonalityModifier(agentName) {
  const normalizedName = agentName.toLowerCase().replace(/\s+/g, '_')
  return PERSONALITY_MODIFIERS[normalizedName] || {
    movePattern: 'normal',
    idleAnimation: 'idle',
    speedModifier: 1.0,
  }
}


/**
 * Calculate effective speed for an agent in a phase
 */
export function getEffectiveSpeed(agentName, phase) {
  const phaseBehavior = getPhaseBehavior(phase)
  const personality = getPersonalityModifier(agentName)
  return phaseBehavior.speed * personality.speedModifier
}


/**
 * Get appropriate animation for agent in current phase
 */
export function getAppropriateAnimation(agentName, phase, activity) {
  const phaseBehavior = getPhaseBehavior(phase)
  const personality = getPersonalityModifier(agentName)
  
  // If specific activity provided, use that
  if (activity && phaseBehavior.animations.includes(activity)) {
    return activity
  }
  
  // Otherwise pick random animation appropriate for phase
  const animations = phaseBehavior.animations
  return animations[Math.floor(Math.random() * animations.length)]
}


/**
 * Lighting configuration for CSS/Canvas rendering
 */
export const LIGHTING_CONFIGS = {
  pre_market: {
    background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    overlay: 'rgba(255, 200, 150, 0.1)',
    agentTint: 0xFFF5E6,
    textGlow: '#FFD700',
  },
  open: {
    background: 'linear-gradient(180deg, #1e3a5f 0%, #1e3a5f 100%)',
    overlay: 'rgba(255, 255, 255, 0.05)',
    agentTint: 0xFFFFFF,
    textGlow: '#FFFFFF',
  },
  midday: {
    background: 'linear-gradient(180deg, #1e2a3a 0%, #2d3e50 100%)',
    overlay: 'rgba(240, 248, 255, 0.05)',
    agentTint: 0xF0F8FF,
    textGlow: '#87CEEB',
  },
  power_hour: {
    background: 'linear-gradient(180deg, #2a1e3a 0%, #3d1e2a 100%)',
    overlay: 'rgba(255, 100, 100, 0.1)',
    agentTint: 0xFFE4E1,
    textGlow: '#FF6B6B',
  },
  after_hours: {
    background: 'linear-gradient(180deg, #0a0a1a 0%, #1a1a3a 50%, #0a0a2a 100%)',
    overlay: 'rgba(65, 105, 225, 0.15)',
    agentTint: 0x4169E1,
    textGlow: '#9370DB',
  },
  weekend: {
    background: 'linear-gradient(180deg, #0a0a15 0%, #15102a 50%, #0a0a20 100%)',
    overlay: 'rgba(72, 61, 139, 0.2)',
    agentTint: 0x483D8B,
    textGlow: '#9370DB',
  },
}


/**
 * Get CSS variables for a phase's lighting
 */
export function getPhaseLightingCSS(phase, lightMode = 'day') {
  const config = LIGHTING_CONFIGS[phase] || LIGHTING_CONFIGS.midday
  
  let background = config.background
  let overlay = config.overlay
  
  if (lightMode === 'night') {
    background = 'linear-gradient(180deg, #0b0b1a 0%, #15152a 100%)'
    overlay = 'rgba(0, 0, 0, 0.35)'
  }

  return {
    '--phase-bg': 'transparent', // Disabled to test canvas rendering
    '--phase-overlay': 'transparent', // Disabled to test canvas rendering
    '--phase-agent-tint': `#${config.agentTint.toString(16).padStart(6, '0')}`,
    '--phase-text-glow': config.textGlow,
  }
}
