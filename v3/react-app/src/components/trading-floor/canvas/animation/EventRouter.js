/**
 * Event Router - Event-driven animation triggering system
 * Supports event subscriptions, priority-based handling, and event-to-animation mapping
 */
export class EventRouter {
  constructor() {
    this.listeners = new Map() // event -> [{ callback, priority }]
    this.eventQueue = []
    this.eventToAnimation = new Map() // eventName -> animationKey
    this.isProcessing = false
    this.maxQueueSize = 1000
  }
  
  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @param {number} priority - Priority (higher = called first)
   */
  on(event, callback, priority = 0) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push({ callback, priority })
    
    // Sort by priority (higher first)
    this.listeners.get(event).sort((a, b) => b.priority - a.priority)
    
    // Return unsubscribe function
    return () => this.off(event, callback)
  }
  
  /**
   * Subscribe to an event (one-time)
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @param {number} priority - Priority
   */
  once(event, callback, priority = 0) {
    const wrapper = (data) => {
      this.off(event, wrapper)
      callback(data)
    }
    return this.on(event, wrapper, priority)
  }
  
  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function to remove
   */
  off(event, callback) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      const idx = callbacks.findIndex(c => c.callback === callback)
      if (idx >= 0) callbacks.splice(idx, 1)
      
      // Clean up empty listener arrays
      if (callbacks.length === 0) {
        this.listeners.delete(event)
      }
    }
  }
  
  /**
   * Emit an event immediately
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.forEach(({ callback }) => {
        try {
          callback(data)
        } catch (err) {
          console.error(`EventRouter: Error in handler for "${event}":`, err)
        }
      })
    }
  }
  
  /**
   * Queue an event for batched processing
   * @param {string} event - Event name
   * @param {*} data - Event data
   * @param {number} priority - Priority (higher = processed first)
   */
  queueEvent(event, data, priority = 0) {
    if (this.eventQueue.length >= this.maxQueueSize) {
      console.warn('EventRouter: Queue full, dropping oldest event')
      this.eventQueue.shift()
    }
    
    this.eventQueue.push({ event, data, priority, timestamp: Date.now() })
    this.eventQueue.sort((a, b) => b.priority - a.priority)
  }
  
  /**
   * Process all queued events
   */
  processQueue() {
    if (this.isProcessing) return
    this.isProcessing = true
    
    while (this.eventQueue.length > 0) {
      const { event, data } = this.eventQueue.shift()
      this.emit(event, data)
    }
    
    this.isProcessing = false
  }
  
  /**
   * Process queued events with a time budget
   * @param {number} maxTimeMs - Maximum time to spend processing in ms
   */
  processQueueWithBudget(maxTimeMs = 16) {
    if (this.isProcessing) return
    this.isProcessing = true
    
    const startTime = performance.now()
    
    while (this.eventQueue.length > 0) {
      const elapsed = performance.now() - startTime
      if (elapsed >= maxTimeMs) break
      
      const { event, data } = this.eventQueue.shift()
      this.emit(event, data)
    }
    
    this.isProcessing = false
  }
  
  /**
   * Map an event to an animation
   * @param {string} eventName - Event name
   * @param {string} animationKey - Animation key to trigger
   */
  mapEventToAnimation(eventName, animationKey) {
    this.eventToAnimation.set(eventName, animationKey)
  }
  
  /**
   * Remove event-to-animation mapping
   * @param {string} eventName - Event name
   */
  unmapEventToAnimation(eventName) {
    this.eventToAnimation.delete(eventName)
  }
  
  /**
   * Handle incoming event and trigger mapped animation
   * @param {string} event - Event name
   * @param {Object} data - Event data (should include controller and spriteName)
   */
  handleEvent(event, data) {
    // Emit the event
    this.emit(event, data)
    
    // Check for animation mapping
    const animKey = this.eventToAnimation.get(event)
    if (animKey && data.controller && data.spriteName) {
      data.controller.play(data.spriteName, animKey, data.options)
    }
  }
  
  /**
   * Get all registered events
   * @returns {string[]} Array of event names
   */
  getRegisteredEvents() {
    return Array.from(this.listeners.keys())
  }
  
  /**
   * Get listener count for an event
   * @param {string} event - Event name
   * @returns {number} Number of listeners
   */
  getListenerCount(event) {
    const callbacks = this.listeners.get(event)
    return callbacks ? callbacks.length : 0
  }
  
  /**
   * Get total listener count
   * @returns {number} Total listeners across all events
   */
  getTotalListenerCount() {
    let total = 0
    for (const callbacks of this.listeners.values()) {
      total += callbacks.length
    }
    return total
  }
  
  /**
   * Clear all listeners for an event
   * @param {string} event - Event name
   */
  clearEvent(event) {
    this.listeners.delete(event)
  }
  
  /**
   * Clear all listeners and mappings
   */
  dispose() {
    this.listeners.clear()
    this.eventQueue = []
    this.eventToAnimation.clear()
  }
}
