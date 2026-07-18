/**
 * Blend Engine - Handles smooth visual transitions between animations
 * Supports cross-fade, layer blending, and various easing functions
 */
export class BlendEngine {
  constructor(scene) {
    this.scene = scene
    this.activeBlends = new Map() // sprite -> blend info
    
    // Standard easing functions
    this.easingFunctions = {
      linear: t => t,
      easeIn: t => t * t,
      easeOut: t => t * (2 - t),
      easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
      easeInCubic: t => t * t * t,
      easeOutCubic: t => {
        const t1 = t - 1
        return t1 * t1 * t1 + 1
      },
      easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
      easeInQuart: t => t * t * t * t,
      easeOutQuart: t => 1 - (--t) * t * t * t,
      easeInOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t,
      easeInExpo: t => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
      easeOutExpo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
      easeInOutExpo: t => {
        if (t === 0) return 0
        if (t === 1) return 1
        if (t < 0.5) return Math.pow(2, 10 * (2 * t - 1)) / 2
        return (2 - Math.pow(2, -10 * (2 * t - 1))) / 2
      },
      bounce: t => {
        if (t < 1/2.75) return 7.5625 * t * t
        if (t < 2/2.75) {
          const t1 = t - 1.5/2.75
          return 7.5625 * t1 * t1 + 0.75
        }
        if (t < 2.5/2.75) {
          const t1 = t - 2.25/2.75
          return 7.5625 * t1 * t1 + 0.9375
        }
        const t1 = t - 2.625/2.75
        return 7.5625 * t1 * t1 + 0.984375
      },
      elastic: t => {
        if (t === 0) return 0
        if (t === 1) return 1
        return Math.pow(2, -10 * t) * Math.sin((t - 0.1) * 5 * Math.PI) + 1
      }
    }
  }
  
  /**
   * Cross-fade between two animation states
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to animate
   * @param {string} fromAnim - The animation to fade from
   * @param {string} toAnim - The animation to fade to
   * @param {number} duration - Duration of the blend in ms
   * @param {string|Function} easing - Easing function name or custom function
   * @param {Function} onComplete - Callback when blend completes
   * @returns {Object} Blend info object
   */
  crossFade(sprite, fromAnim, toAnim, duration = 200, easing = 'easeInOut', onComplete = null) {
    // Cancel existing blend for this sprite
    this.cancelBlend(sprite)
    
    // Get easing function
    const easingFn = typeof easing === 'function' 
      ? easing 
      : (this.easingFunctions[easing] || this.easingFunctions.linear)
    
    const blendInfo = {
      sprite,
      fromAnim,
      toAnim,
      duration,
      elapsed: 0,
      easing: easingFn,
      onComplete,
      startTime: Date.now()
    }
    
    this.activeBlends.set(sprite, blendInfo)
    
    // Start new animation at alpha 0
    sprite.setAlpha(0)
    
    // Play the target animation
    if (toAnim && sprite.anims) {
      sprite.play(toAnim, true)
    }
    
    return blendInfo
  }
  
  /**
   * Layer blend - blend upper/lower body separately
   * Note: This would require sprite sheets with separate upper/lower regions
   * For now, falls back to cross-fade
   */
  layerBlend(sprite, upperAnim, lowerAnim, duration = 200) {
    // Placeholder for future implementation
    // Would require multi-part sprites
    return this.crossFade(sprite, upperAnim, lowerAnim, duration)
  }
  
  /**
   * Update all active blends - called every frame
   * @param {number} deltaTime - Time since last update in seconds
   */
  update(deltaTime) {
    const completed = []
    
    for (const [sprite, blend] of this.activeBlends) {
      blend.elapsed += deltaTime * 1000 // Convert to ms
      
      const progress = Math.min(blend.elapsed / blend.duration, 1)
      const easedProgress = blend.easing(progress)
      
      // Update alpha with eased progress
      sprite.setAlpha(easedProgress)
      
      if (progress >= 1) {
        completed.push(sprite)
      }
    }
    
    // Handle completed blends
    for (const sprite of completed) {
      const blend = this.activeBlends.get(sprite)
      this.activeBlends.delete(sprite)
      
      // Ensure final alpha is 1
      sprite.setAlpha(1)
      
      if (blend.onComplete) {
        try {
          blend.onComplete()
        } catch (err) {
          console.error('BlendEngine: Error in onComplete callback:', err)
        }
      }
    }
  }
  
  /**
   * Cancel an active blend for a sprite
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to cancel blend for
   * @returns {boolean} True if a blend was cancelled
   */
  cancelBlend(sprite) {
    if (this.activeBlends.has(sprite)) {
      sprite.setAlpha(1) // Reset alpha
      this.activeBlends.delete(sprite)
      return true
    }
    return false
  }
  
  /**
   * Check if a sprite is currently blending
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to check
   * @returns {boolean} True if blending
   */
  isBlending(sprite) {
    return this.activeBlends.has(sprite)
  }
  
  /**
   * Get blend progress for a sprite
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to check
   * @returns {number} Progress from 0 to 1, or 1 if not blending
   */
  getBlendProgress(sprite) {
    const blend = this.activeBlends.get(sprite)
    if (!blend) return 1
    return Math.min(blend.elapsed / blend.duration, 1)
  }
  
  /**
   * Get blend info for a sprite
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to check
   * @returns {Object|null} Blend info or null
   */
  getBlendInfo(sprite) {
    return this.activeBlends.get(sprite) || null
  }
  
  /**
   * Pause a blend for a sprite
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to pause
   * @returns {boolean} True if paused
   */
  pauseBlend(sprite) {
    const blend = this.activeBlends.get(sprite)
    if (blend) {
      blend.paused = true
      return true
    }
    return false
  }
  
  /**
   * Resume a paused blend
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to resume
   * @returns {boolean} True if resumed
   */
  resumeBlend(sprite) {
    const blend = this.activeBlends.get(sprite)
    if (blend && blend.paused) {
      blend.paused = false
      return true
    }
    return false
  }
  
  /**
   * Add a custom easing function
   * @param {string} name - Name of the easing function
   * @param {Function} fn - Easing function (takes t 0-1, returns eased value)
   */
  addEasing(name, fn) {
    this.easingFunctions[name] = fn
  }
  
  /**
   * Get all active blend count
   * @returns {number} Number of active blends
   */
  getActiveBlendCount() {
    return this.activeBlends.size
  }
  
  /**
   * Cleanup all blends
   */
  dispose() {
    for (const [sprite] of this.activeBlends) {
      sprite.setAlpha(1)
    }
    this.activeBlends.clear()
  }
}
