/**
 * Resource Pool - Memory management for animations
 * Handles sprite recycling, texture caching, tween tracking, and garbage collection
 */
export class ResourcePool {
  constructor(scene) {
    this.scene = scene
    this.sprites = new Map() // name -> { sprite, lastUsed, refCount }
    this.tweens = new Map() // name -> Set of tweens
    this.textures = new Map() // key -> { texture, refCount }
    this.timers = new Map() // name -> Set of timer IDs
    
    // Cleanup configuration
    this.cleanupInterval = 30000 // 30 seconds
    this.maxIdleTime = 60000 // 1 minute
    this.maxTweensPerSprite = 10
    this.lastCleanup = Date.now()
    
    // Statistics
    this.stats = {
      spritesRegistered: 0,
      spritesReleased: 0,
      tweensCreated: 0,
      tweensRemoved: 0,
      cleanupsRun: 0
    }
  }
  
  /**
   * Register a sprite for management
   * @param {string} name - Unique identifier
   * @param {Phaser.GameObjects.Sprite} sprite - The sprite to register
   */
  register(name, sprite) {
    if (this.sprites.has(name)) {
      console.warn(`ResourcePool: Sprite "${name}" already registered, updating reference`)
      const data = this.sprites.get(name)
      data.sprite = sprite
      data.lastUsed = Date.now()
      data.refCount++
      return
    }
    
    this.sprites.set(name, {
      sprite,
      lastUsed: Date.now(),
      refCount: 1
    })
    
    this.stats.spritesRegistered++
  }
  
  /**
   * Release a sprite and its resources
   * @param {string} name - Sprite identifier
   */
  release(name) {
    const data = this.sprites.get(name)
    if (!data) return
    
    // Cancel any active tweens
    const tweens = this.tweens.get(name)
    if (tweens) {
      tweens.forEach(tween => {
        if (tween && this.scene.tweens) {
          this.scene.tweens.remove(tween)
        }
      })
      this.tweens.delete(name)
    }
    
    // Clear timers
    const timers = this.timers.get(name)
    if (timers) {
      timers.forEach(timerId => {
        if (this.scene.time) {
          this.scene.time.removeEvent(timerId)
        }
      })
      this.timers.delete(name)
    }
    
    this.sprites.delete(name)
    this.stats.spritesReleased++
  }
  
  /**
   * Track a tween for cleanup
   * @param {string} name - Sprite identifier
   * @param {Phaser.Tweens.Tween} tween - The tween to track
   */
  trackTween(name, tween) {
    if (!this.tweens.has(name)) {
      this.tweens.set(name, new Set())
    }
    
    const tweenSet = this.tweens.get(name)
    
    // Limit tweens per sprite
    if (tweenSet.size >= this.maxTweensPerSprite) {
      const oldest = tweenSet.values().next().value
      if (oldest && this.scene.tweens) {
        this.scene.tweens.remove(oldest)
        tweenSet.delete(oldest)
        this.stats.tweensRemoved++
      }
    }
    
    tweenSet.add(tween)
    this.stats.tweensCreated++
    
    // Auto-remove on complete
    if (tween && tween.setCallback) {
      tween.setCallback('onComplete', () => {
        tweenSet.delete(tween)
        this.stats.tweensRemoved++
      })
    }
  }
  
  /**
   * Track a timer for cleanup
   * @param {string} name - Sprite identifier
   * @param {Phaser.Time.TimerEvent} timer - The timer to track
   */
  trackTimer(name, timer) {
    if (!this.timers.has(name)) {
      this.timers.set(name, new Set())
    }
    this.timers.get(name).add(timer)
  }
  
  /**
   * Mark sprite as recently used
   * @param {string} name - Sprite identifier
   */
  markUsed(name) {
    const data = this.sprites.get(name)
    if (data) {
      data.lastUsed = Date.now()
    }
  }
  
  /**
   * Reference a texture
   * @param {string} key - Texture key
   */
  referenceTexture(key) {
    if (!this.textures.has(key)) {
      this.textures.set(key, { refCount: 0 })
    }
    this.textures.get(key).refCount++
  }
  
  /**
   * Release a texture reference
   * @param {string} key - Texture key
   */
  releaseTexture(key) {
    const data = this.textures.get(key)
    if (data) {
      data.refCount--
      if (data.refCount <= 0) {
        this.textures.delete(key)
      }
    }
  }
  
  /**
   * Update - periodic cleanup check
   * @param {number} deltaTime - Time since last update in seconds
   */
  update(deltaTime) {
    const now = Date.now()
    
    if (now - this.lastCleanup > this.cleanupInterval) {
      this.cleanup()
      this.lastCleanup = now
    }
  }
  
  /**
   * Cleanup unused resources
   */
  cleanup() {
    this.stats.cleanupsRun++
    const now = Date.now()
    
    // Log idle sprites for debugging (don't auto-remove, managed externally)
    let idleCount = 0
    for (const [name, data] of this.sprites) {
      if (now - data.lastUsed > this.maxIdleTime) {
        idleCount++
      }
    }
    
    if (idleCount > 0) {
      console.debug(`ResourcePool: ${idleCount} sprites idle for >${this.maxIdleTime}ms`)
    }
    
    // Cleanup unreferenced textures
    let textureCleanup = 0
    for (const [key, data] of this.textures) {
      if (data.refCount <= 0) {
        this.textures.delete(key)
        textureCleanup++
      }
    }
    
    if (textureCleanup > 0) {
      console.debug(`ResourcePool: Cleaned ${textureCleanup} unreferenced textures`)
    }
  }
  
  /**
   * Force cleanup of all resources
   */
  forceCleanup() {
    // Cancel all tweens
    for (const [name, tweenSet] of this.tweens) {
      tweenSet.forEach(tween => {
        if (tween && this.scene.tweens) {
          this.scene.tweens.remove(tween)
        }
      })
    }
    
    // Clear all timers
    for (const [name, timerSet] of this.timers) {
      timerSet.forEach(timer => {
        if (timer && this.scene.time) {
          this.scene.time.removeEvent(timer)
        }
      })
    }
    
    this.tweens.clear()
    this.timers.clear()
    this.textures.clear()
  }
  
  /**
   * Get statistics
   * @returns {Object} Stats object
   */
  getStats() {
    let totalTweens = 0
    for (const tweenSet of this.tweens.values()) {
      totalTweens += tweenSet.size
    }
    
    let totalTimers = 0
    for (const timerSet of this.timers.values()) {
      totalTimers += timerSet.size
    }
    
    return {
      ...this.stats,
      activeSprites: this.sprites.size,
      activeTweens: totalTweens,
      activeTimers: totalTimers,
      activeTextures: this.textures.size
    }
  }
  
  /**
   * Get sprite by name
   * @param {string} name - Sprite identifier
   * @returns {Phaser.GameObjects.Sprite|null}
   */
  getSprite(name) {
    const data = this.sprites.get(name)
    return data ? data.sprite : null
  }
  
  /**
   * Check if sprite is registered
   * @param {string} name - Sprite identifier
   * @returns {boolean}
   */
  hasSprite(name) {
    return this.sprites.has(name)
  }
  
  /**
   * Get all registered sprite names
   * @returns {string[]}
   */
  getSpriteNames() {
    return Array.from(this.sprites.keys())
  }
  
  /**
   * Dispose of all resources
   */
  dispose() {
    // Cancel all tracked tweens
    for (const [name, tweenSet] of this.tweens) {
      tweenSet.forEach(tween => {
        if (tween && this.scene.tweens) {
          this.scene.tweens.remove(tween)
        }
      })
    }
    
    // Clear all timers
    for (const [name, timerSet] of this.timers) {
      timerSet.forEach(timer => {
        if (timer && this.scene.time) {
          this.scene.time.removeEvent(timer)
        }
      })
    }
    
    // Clear all maps
    this.sprites.clear()
    this.tweens.clear()
    this.timers.clear()
    this.textures.clear()
  }
}
