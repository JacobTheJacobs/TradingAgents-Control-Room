// Trading Floor Scene - Phaser Scene Class
import Phaser from 'phaser'
import { TILE_SIZE, ROOM_MAP, TILE_TYPES, AGENTS, GATHER_SPOTS, AGENT_STATIONS, STATION_TILE_MAP, resolveAgentName } from '../../../utils/constants'
import { generateTextures } from './assets'
import { createAllAnimations } from './animations'
import { getGridPos, findPathToCoord, isWalkable } from './pathfinding'
import { AnimationController, AnimStateType } from './animation'
import { Showrunner } from './Showrunner'
import { MovementManager, MovePriority } from './MovementManager'

export class TradingFloorScene extends Phaser.Scene {
  constructor() {
    super({ key: 'TradingFloorScene' })
    this.roomMap = (typeof window !== 'undefined' && Array.isArray(window.ROOM_MAP)) ? window.ROOM_MAP : ROOM_MAP
    this.roomSprites = []
    this.agents = {}
    this.occupiedDesks = new Set()
    this.gatherSpotsDynamic = null
    this.animController = null
    this.showrunner = null
    this.movementManager = null
    this.particles = []
    this.reflections = {}
    this.sentiment = 0 // -1 to 1
    this.lastUpdateErrorAt = 0
  }

  getRoomMap() {
    if (Array.isArray(this.roomMap) && this.roomMap.length > 0 && Array.isArray(this.roomMap[0])) {
      return this.roomMap
    }
    if (typeof window !== 'undefined' && Array.isArray(window.ROOM_MAP) && window.ROOM_MAP.length > 0 && Array.isArray(window.ROOM_MAP[0])) {
      this.roomMap = window.ROOM_MAP
      return this.roomMap
    }
    return ROOM_MAP
  }

  setRoomMap(mapData) {
    if (!Array.isArray(mapData) || mapData.length === 0 || !Array.isArray(mapData[0])) return
    this.roomMap = mapData
    if (typeof window !== 'undefined') {
      window.ROOM_MAP = mapData
    }
    ROOM_MAP.length = 0
    mapData.forEach((row) => ROOM_MAP.push([...row]))
  }

  async create() {
    console.log("Phaser Scene: Starting Create...");

    // Get mode from global (set by TradingFloorPageContent)
    this.mode = window.TRADING_FLOOR_MODE || 'obs'
    console.log(`Phaser Scene: Mode = ${this.mode}`);

    try {
      console.log("Phaser Scene: Generating Textures...");
      generateTextures(this)
      console.log("Phaser Scene: Creating Animations...");
      createAllAnimations(this)
      console.log("Phaser Scene: Building Room...");
      this.buildRoom()
      this.refreshGatherSpots()
      console.log("Phaser Scene: Creating Agents...");
      this.createAgents()
      
      // Auto-deploy agents to their stations after a brief pause
      this.time.delayedCall(800, () => {
        this.deployAgentsToStations();
      });

      console.log("Phaser Scene: Setting Camera...");
      this.updateCameraScale();
      this.setupBlueprintMode()

      this.scale.on('resize', (_gameSize) => {
        // Stretch to fill the card (no cropping, may distort)
        const canvas = this.game.canvas;
        if (canvas) {
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.objectFit = 'fill';
        }
        this.updateCameraScale();
      });

      // Direct listener for commands (bypass Showrunner if needed)
      window.addEventListener('SCENE_COMMAND', (e) => {
        if (e.detail?.type === 'SET_LIGHTING') {
          console.log('[Phaser Scene] Direct SET_LIGHTING command received:', e.detail.mode);
          this.setLighting(e.detail.mode);
        }
      });

      console.log(`Phaser Scene: Create Complete`);
    } catch (err) {
      console.error("CRITICAL: Phaser Scene Create Error:", err);
    }
  }

  updateCameraScale() {
    const { width, height } = this.scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    // Room is 640x448. Stretch to fill container (no crop, non-uniform).
    const scaleX = width / 640;
    const scaleY = height / 448;
    this.cameras.main.setViewport(0, 0, width, height);
    this.cameras.main.setZoom(scaleX, scaleY);
    this.cameras.main.centerOn(320, 224);
  }

  /**
   * Automatically moves all agents from their initial spawn points 
   * to their canonical work stations (desks, scanner, etc.)
   */
  deployAgentsToStations() {
    console.log("TradingFloorScene: Deploying agents to stations...");
    
    // We iterate through all agents and find their assigned station 
    // from the TRADING_AGENT_STATIONS config.
    Object.keys(this.agents).forEach(name => {
      const stationConfig = AGENT_STATIONS[name];
      let stationType = stationConfig ? stationConfig.station : 'table';
      
      // If the agent doesn't have an explicit desk assignment, 
      // they should move to the central collaboration table 
      // to keep them organized around the meeting area.
      if (stationType !== 'desk') {
        stationType = 'table';
      }
      
      if (this.movementManager) {
        this.movementManager.moveAgent(name, stationType, MovePriority.USER, 'initial_spawn_deployment');
      }
    });
  }

  buildRoom() {
    const roomMap = this.getRoomMap()
    if (this.roomSprites) {
      this.roomSprites.forEach(sprite => {
        if (sprite && sprite.destroy) sprite.destroy()
      })
    }
    this.roomSprites = []

    const addRoomSprite = (sprite) => {
      this.roomSprites.push(sprite)
      return sprite
    }

    for (let row = 0; row < roomMap.length; row++) {
      for (let col = 0; col < roomMap[0].length; col++) {
        const type = roomMap[row][col]
        const x = col * TILE_SIZE + TILE_SIZE / 2
        const y = row * TILE_SIZE + TILE_SIZE / 2

        addRoomSprite(this.add.image(x, y, 'floor').setDepth(0))

        if (type === TILE_TYPES.WALL) {
          let key = 'wall_face'
          if (row === 0 && (col === 0 || col === roomMap[0].length - 1)) key = 'wall_corner'
          else if (col === 0 || col === roomMap[0].length - 1) key = 'wall_side'
          else if (row === roomMap.length - 1) key = 'wall_corner'
          addRoomSprite(this.add.image(x, y, key).setDepth(y))
        } else if (type === TILE_TYPES.WINDOW) {
          addRoomSprite(this.add.image(x, y, 'window').setDepth(y))
        } else if (type === TILE_TYPES.DOOR) {
          addRoomSprite(this.add.image(x, y, 'door').setDepth(y))
        } else if (type === TILE_TYPES.RUG) {
          addRoomSprite(this.add.image(x, y, 'rug').setDepth(0.1))
        } else if (type === TILE_TYPES.PLANT) {
          addRoomSprite(this.add.image(x, y - 8, 'plant').setDepth(y))
        } else if (type === TILE_TYPES.MONEY) {
          // Money tiles are intentionally hidden from the canvas.
        } else if (type === TILE_TYPES.CABINET) {
          addRoomSprite(this.add.image(x, y - 8, 'cabinet').setDepth(y))
        } else if (type === TILE_TYPES.DESK) {
          let contiguousDesksBefore = 0;
          for (let i = col - 1; i >= 0; i--) {
            if (roomMap[row][i] === TILE_TYPES.DESK) contiguousDesksBefore++;
            else break;
          }
          // Only spawn a desk if this is the start of a triplet
          if (contiguousDesksBefore % 3 === 0 && roomMap[row][col + 1] === TILE_TYPES.DESK && roomMap[row][col + 2] === TILE_TYPES.DESK) {
            // The center of a 3-tile desk is `x + 32` because `x` is the center of the first tile.
            // The visual tile center for an agent at the desk is roughly y + 16 (since y is the row start).
            // When sitting, the MovementManager lifts them slightly into the seat so the chair mask
            // stays in front without reducing the sprite to a face-only silhouette.

            // 1. Desk Base (monitors, table surface) -> behind the agent
            const deskBase = addRoomSprite(this.add.image(x + 32, y - 8, 'desk_base'))
            deskBase.setDepth(y - 20) // 128 - 20 = 108. Drawn behind agent's 132.
            
            // 2. Desk Chair (chair back) -> in front of the agent
            const deskChair = addRoomSprite(this.add.image(x + 32, y - 8, 'desk_chair'))
            deskChair.setDepth(y + 10) // 128 + 10 = 138. Drawn in front of agent's 132.

            // Add screen glow above monitors (attached to base depth)
            const glow = addRoomSprite(this.add.image(x + 32, y - 18, 'screen_glow'))
            glow.setBlendMode(Phaser.BlendModes.ADD)
            glow.setDepth(y - 4.9)
            glow.setAlpha(0.7)
          }
        } else if (type === TILE_TYPES.TICKER) {
          if (col === 0 || roomMap[row][col - 1] !== TILE_TYPES.TICKER) {
            const ticker = addRoomSprite(this.add.sprite(x + 32, y - 8, 'ticker'))
            ticker.setDepth(y)
            ticker.play('ticker_anim')
          }
        } else if (type === TILE_TYPES.TV) {
          if (col === 0 || roomMap[row][col - 1] !== TILE_TYPES.TV) {
            const tv = addRoomSprite(this.add.sprite(x + 16, y - 8, 'tv'))
            tv.setDepth(y)
            tv.play('tv_channel')
            // Add TV glow
            const tvGlow = addRoomSprite(this.add.image(x + 16, y - 16, 'tv_glow'))
            tvGlow.setBlendMode(Phaser.BlendModes.ADD)
            tvGlow.setDepth(y + 0.1)
            tvGlow.setAlpha(0.6)
          }
        } else if (type === TILE_TYPES.COOLER) {
          addRoomSprite(this.add.image(x, y - 8, 'cooler').setDepth(y))
        } else if (type === TILE_TYPES.NEWSSTAND) {
          addRoomSprite(this.add.image(x, y, 'news').setDepth(y))
        } else if (type === TILE_TYPES.SCANNER) {
          const scanner = addRoomSprite(this.add.circle(x, y, 20, 0xFFD700, 0.3))
          scanner.setDepth(y - 1)
          addRoomSprite(this.add.text(x, y, '🔍', { fontSize: '32px' }).setOrigin(0.5).setDepth(y))
        } else if (type === TILE_TYPES.TABLE) {
          // Check if this is the top-left of a 3x3 table block
          const isAtTop = row === 0 || roomMap[row - 1][col] !== TILE_TYPES.TABLE;
          const isAtLeft = col === 0 || roomMap[row][col - 1] !== TILE_TYPES.TABLE;
          
          if (isAtTop && isAtLeft) {
            // Spawn one large 3x3 table for the entire block
            // x, y is the center of the top-left tile (row, col)
            // The 3x3 area center is (x+32, y+32)
            const table = addRoomSprite(this.add.image(x + 32, y + 24, 'table_96'))
            table.setDepth(y + 24) // Depth near the visual centerline so agents behind it are hidden, those to the side/front are overlaid
          }
        }
      }
    }

    // Add ambient particles for "depth" and atmosphere
    this.createAmbientParticles()

    // Add casino lighting overlay (radial gradient - bright center, dim edges)
    this.createCasinoLighting()
  }

  /**
   * Create ambient pixel dust particles
   */
  createAmbientParticles() {
    for (let i = 0; i < 20; i++) {
        const x = Phaser.Math.Between(0, 640)
        const y = Phaser.Math.Between(0, 448)
        const p = this.add.rectangle(x, y, 1, 1, 0xffffff, 0.2)
        p.setDepth(9990)
        this.particles.push({
            sprite: p,
            speed: Phaser.Math.FloatBetween(0.05, 0.2),
            dir: Phaser.Math.FloatBetween(0, Math.PI * 2)
        })
    }
  }

  /**
   * Update agent reflections for "depth"
   */
  updateReflections() {
    // Disabled shadows/reflections to remove dark/white glitches and unwanted shadows entirely
    return;
  }


  /**
   * Create casino-style lighting overlay
   * Uses a radial gradient with MULTIPLY blend mode
   * Much cheaper than Phaser's dynamic lighting system
   */
  createCasinoLighting() {
    if (this.lightingOverlay) {
      this.lightingOverlay.destroy()
    }
    if (this.sentimentGlow) {
      this.sentimentGlow.destroy()
    }
    if (this.textures.exists('casino_lighting')) {
      this.textures.remove('casino_lighting')
    }

    const width = 640
    const height = 448
    const centerX = width / 2
    const centerY = height / 2

    // Create canvas for lighting overlay
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')

    // Create radial gradient - bright in center, darker at edges
    const gradient = ctx.createRadialGradient(
      centerX, centerY, 50,  // Inner circle (bright)
      centerX, centerY, 350  // Outer circle (dark)
    )

    // Casino lighting colors (lighter to avoid overly dark floor)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')    // Center - full brightness
    gradient.addColorStop(0.35, 'rgba(250, 245, 235, 0.95)')
    gradient.addColorStop(0.65, 'rgba(230, 215, 200, 0.85)') // Warm midtones
    gradient.addColorStop(0.85, 'rgba(200, 185, 175, 0.75)') // Soft edges
    gradient.addColorStop(1, 'rgba(170, 160, 150, 0.65)')    // Light corners

    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)

    // Always register the texture so sentiment glow has a valid source
    this.textures.addCanvas('casino_lighting', canvas)

    // Lighting overlay for day/night atmosphere (safe, no texture regen)
    const lightingOverlay = this.add.image(centerX, centerY, 'casino_lighting')
    lightingOverlay.setBlendMode(Phaser.BlendModes.MULTIPLY)
    lightingOverlay.setDepth(9998)
    lightingOverlay.setAlpha(0.0)
    this.lightingOverlay = lightingOverlay
    
    // Add a secondary "Bloom" layer for sentiment
    this.sentimentGlow = this.add.image(centerX, centerY, 'casino_lighting')
    this.sentimentGlow.setBlendMode(Phaser.BlendModes.ADD)
    this.sentimentGlow.setDepth(9997)
    this.sentimentGlow.setAlpha(0) 
  }

  updateSentimentGlow() {
    if (!this.sentimentGlow) return
    
    // Smooth transition to target sentiment colors
    const targetAlpha = Math.abs(this.sentiment) * 0.1 // Much lighter
    const targetColor = this.sentiment > 0 ? 0x00ff00 : 0xff0000
    
    this.sentimentGlow.setAlpha(Phaser.Math.Linear(this.sentimentGlow.alpha, targetAlpha, 0.1))
    this.sentimentGlow.setTint(targetColor)
  }

  /**
   * Set lighting mode - changes the atmosphere of the trading floor
   * @param {string} mode - 'day', 'night', or 'panic'
   */
  setLighting(mode) {
    const presets = {
      day: { alpha: 0.06, tint: 0xffffff },
      night: { alpha: 0.18, tint: 0xcfd9ff },
      panic: { alpha: 0.22, tint: 0xffc3c3 }
    }

    // 1. Update overlay if it exists
    if (this.lightingOverlay) {
      const preset = presets[mode] || presets.day
      // Use softer blend in day/night to keep brightness
      if (mode === 'day') {
        this.lightingOverlay.setBlendMode(Phaser.BlendModes.SCREEN)
      } else if (mode === 'night') {
        this.lightingOverlay.setBlendMode(Phaser.BlendModes.MULTIPLY)
      } else {
        this.lightingOverlay.setBlendMode(Phaser.BlendModes.ADD)
      }
      this.lightingOverlay.setAlpha(preset.alpha)
      this.lightingOverlay.setTint(preset.tint)
      console.log(`Lighting overlay updated to: ${mode}`)
    } else {
      console.log(`Lighting mode set to: ${mode} (Overlay missing)`)
    }

    // 2. Avoid runtime texture regeneration (prevents WebGL null textures)
    // Instead, softly tint existing room sprites to simulate day/night.
    if (mode === 'day' || mode === 'night' || mode === 'panic') {
      const tint = (presets[mode] || presets.day).tint
      if (this.roomSprites) {
        this.roomSprites.forEach(sprite => {
          if (sprite && sprite.setTint) sprite.setTint(tint)
        })
      }
    }
  }

  createAgents() {
    this.highlights = {} // Track pokemon-style highlight rings

    const agentList = Object.entries(AGENTS);
    agentList.forEach(([name, config], index) => {
      // 1. Determine Spawn Position (Meeting Grid around collaboration table)
      // Use dynamic table gathering spots for the initial "meeting" formation
      const tableSpots = this.getGatherSpots('table') || GATHER_SPOTS.table;
      const spawnGridPoint = tableSpots[index % tableSpots.length];
      const spawnX = (spawnGridPoint.c * 32) + 16;
      const spawnY = (spawnGridPoint.r * 32) + 16;

      // Create highlight ring (pulsating ellipse under agent)
      const highlight = this.add.ellipse(spawnX, spawnY + 14, 28, 14, 0xffd700, 0.6)
      highlight.setBlendMode(Phaser.BlendModes.ADD)
      highlight.setDepth(spawnY - 0.1)
      highlight.setVisible(false)
      highlight.setAlpha(0);
      this.highlights[name] = highlight

      // 2. Spawn actual agent at the spawn cluster
      const key = `agent_${name.toLowerCase()}`
      const agent = this.add.sprite(spawnX, spawnY, key)
      agent.setDepth(agent.y)
      agent.play(`${key}_idle`)

      agent.agentName = name
      agent.personality = config.personality
      // Preserving the original desk position as the homePos
      agent.homePos = getGridPos(config.position.x, config.position.y)
      agent.fatigue = 0
      agent.status = 'idle'
      agent.active = true

      this.agents[name] = agent
    })

    // Initialize Animation Controller after all agents are created
    this.animController = new AnimationController(this, {
      maxConcurrentAnimations: 50,
      defaultBlendDuration: 150,
      enableGapFilling: true,
      debug: false
    })

    // Register all agents with the animation controller
    for (const [name, agent] of Object.entries(this.agents)) {
      this.animController.register(name, agent, AnimStateType.IDLE)
    }

    console.log(`AnimationController: Initialized with ${Object.keys(this.agents).length} agents`)

    // Initialize MovementManager — single source of truth for all agent movement
    this.movementManager = new MovementManager(this)
    console.log('MovementManager: Initialized')

    // Initialize Showrunner - the Director that handles scene orchestration
    this.showrunner = new Showrunner(this)
    console.log('Showrunner: Initialized')
  }

  /**
   * Move an agent to a station type.
   * Now delegates to MovementManager for priority-based, cancellable movement.
   * @param {string} agentName — full agent name
   * @param {string} stationType — station key (desk, scanner, tv, cooler, table, ticker)
   * @param {number} priority — MovePriority value (default: AUTOMATED)
   * @param {string} source — caller identifier for debugging
   * @returns {boolean} true if accepted
   */
  moveAgentToStation(agentName, stationType, priority = MovePriority.AUTOMATED, source = 'scene') {
    if (this.movementManager) {
      return this.movementManager.moveAgent(agentName, stationType, priority, source)
    }

    // Fallback if MovementManager not yet initialized (shouldn't happen in practice)
    console.warn('[TradingFloorScene] MovementManager not available, skipping move')
    return false
  }

  showSpeechBubble(agent, text, duration = 3000) {
    if (!agent || !agent.active) return

    // Remove existing bubble if any
    if (agent.currentBubble) {
      agent.currentBubble.destroy()
    }

    const bubblePadding = 10
    const bubbleWidth = Math.min(200, text.length * 8 + 20)
    const bubbleHeight = 40

    const container = this.add.container(agent.x, agent.y - 60)
    container.setDepth(10001)

    const bubble = this.add.graphics()
    bubble.fillStyle(0xffffff, 1)
    bubble.lineStyle(2, 0x000000, 1)
    bubble.fillRoundedRect(-bubbleWidth / 2, -bubbleHeight, bubbleWidth, bubbleHeight, 10)
    bubble.strokeRoundedRect(-bubbleWidth / 2, -bubbleHeight, bubbleWidth, bubbleHeight, 10)

    // Triangle/pointer
    bubble.beginPath()
    bubble.moveTo(-5, 0)
    bubble.lineTo(5, 0)
    bubble.lineTo(0, 5)
    bubble.closePath()
    bubble.fillPath()
    bubble.strokePath()

    const content = this.add.text(0, -bubbleHeight / 2, text, {
      fontFamily: '"Press Start 2P"',
      fontSize: '8px',
      color: '#000000',
      align: 'center',
      wordWrap: { width: bubbleWidth - bubblePadding * 2 }
    })
    content.setOrigin(0.5)

    container.add([bubble, content])
    agent.currentBubble = container

    // Animate in
    container.setScale(0)
    this.tweens.add({
      targets: container,
      scale: 1,
      duration: 200,
      ease: 'Back.easeOut'
    })

    // Remove after duration
    this.time.delayedCall(duration, () => {
      if (container && container.active) {
        this.tweens.add({
          targets: container,
          scale: 0,
          alpha: 0,
          duration: 200,
          onComplete: () => {
            container.destroy()
            if (agent.currentBubble === container) {
              agent.currentBubble = null
            }
          }
        })
      }
    })
  }

  startPathMovement(agent, path, onComplete) {
    // Ensure any leftover overlapping tweens are killed
    if (this.tweens) this.tweens.killTweensOf(agent)

    if (!path || path.length === 0) {
      if (onComplete) onComplete()
      return
    }

    let stepIdx = 0
    const moveNext = () => {
      if (stepIdx >= path.length) {
        // Use AnimationController for idle transition
        if (this.animController && agent.agentName) {
          this.animController.reset(agent.agentName, AnimStateType.IDLE)
        } else {
          const key = `agent_${agent.agentName.toLowerCase()}`
          agent.play(`${key}_idle`, true)
        }
        if (onComplete) onComplete()
        return
      }

      const p = path[stepIdx]
      stepIdx++

      const dx = p.x - agent.x
      const dy = p.y - agent.y

      // Determine animation based on direction
      let walkAnim = AnimStateType.WALK_SIDE
      if (Math.abs(dy) > Math.abs(dx)) {
        walkAnim = dy > 0 ? AnimStateType.WALK_DOWN : AnimStateType.WALK_UP
      }

      // Flip for left movement
      if (Math.abs(dx) > Math.abs(dy) && dx < 0) {
        agent.setFlipX(true)
      } else if (Math.abs(dx) > Math.abs(dy)) {
        agent.setFlipX(false)
      }

      // Use AnimationController for smooth walking animation
      if (this.animController && agent.agentName) {
        this.animController.play(agent.agentName, walkAnim, { blendDuration: 100 })
      } else {
        const key = `agent_${agent.agentName.toLowerCase()}`
        agent.play(`${key}_${walkAnim}`, true)
      }

      this.tweens.add({
        targets: agent,
        x: p.x,
        y: p.y,
        duration: 200,
        ease: 'Linear',
        onUpdate: () => {
          // Dynamic depth sorting while walking
          if (agent && agent.active) agent.setDepth(agent.y)
        },
        onComplete: moveNext
      })
    }

    moveNext()
  }

  getAgentPosition(agentName) {
    const agent = this.agents[agentName]
    if (agent) {
      return { x: agent.x, y: agent.y }
    }
    return null
  }

  update(time, delta) {
    const logUpdateError = (error, scope) => {
      const now = Date.now()
      if (now - this.lastUpdateErrorAt < 2000) return
      this.lastUpdateErrorAt = now
      console.error(`[TradingFloorScene] update failure in ${scope}:`, error)
    }

    try {
      if (this.animController) {
        this.animController.update(delta / 1000)
      }
    } catch (error) {
      logUpdateError(error, 'animController')
    }

    try {
      // Y-sorting for dynamic objects only (agents)
      // Static objects (walls, desks) have depth set once in buildRoom()
      Object.entries(this.agents || {}).forEach(([name, agent]) => {
        if (!agent?.active) return
        agent.setDepth(agent.y)
        // Keep highlight pinned under feet
        if (this.highlights && this.highlights[name]) {
          this.highlights[name].x = agent.x
          this.highlights[name].y = agent.y + 14
          this.highlights[name].setDepth(agent.y - 0.1)
        }
      })
    } catch (error) {
      logUpdateError(error, 'agent-depth')
    }

    try {
      this.updateReflections()
    } catch (error) {
      logUpdateError(error, 'reflections')
    }

    try {
      ;(this.particles || []).forEach((particle) => {
        const sprite = particle?.sprite
        if (!sprite?.active) return
        sprite.x += Math.cos(particle.dir) * particle.speed
        sprite.y += Math.sin(particle.dir) * particle.speed
        if (sprite.x < 0) sprite.x = 640
        if (sprite.x > 640) sprite.x = 0
        if (sprite.y < 0) sprite.y = 448
        if (sprite.y > 448) sprite.y = 0
      })
    } catch (error) {
      logUpdateError(error, 'particles')
    }

    try {
      this.updateSentimentGlow()
    } catch (error) {
      logUpdateError(error, 'sentiment-glow')
    }

    try {
      if (this.showrunner?.debugMode) {
        this.showrunner.drawDebugOverlay()
      }
    } catch (error) {
      logUpdateError(error, 'debug-overlay')
    }
  }

  /**
   * Highlight specified agents on the canvas ("Pokemon style")
   * @param {string[]} agentNames - Array of agent names (e.g. ['Market Analyst'])
   * @param {boolean} enabled - Whether to enable or disable the highlight
   */
  highlightAgents(agentNames = [], enabled = true) {
    if (!this.highlights) return

    // If disabled, hide ALL highlights
    if (!enabled || !agentNames || agentNames.length === 0) {
      Object.values(this.highlights).forEach(h => h.setVisible(false))
      return
    }

    // Normalize input agent names (convert to Title Case if they arrive as snake_case)
    const targets = agentNames.map(name => {
      if (name.includes('_')) {
        return name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
      }
      return name
    })

    // Toggle visibility based on whether the agent is in the target list
    Object.entries(this.highlights).forEach(([name, highlight]) => {
      if (targets.includes(name)) {
        highlight.setVisible(true)
      } else {
        highlight.setVisible(false)
      }
    })
  }

  /**
   * Play animation using the AnimationController with smooth transitions
   * @param {string} agentName - Agent name
   * @param {string} animKey - Animation key (without agent prefix)
   * @param {Object} options - Animation options
  */
  playAnimation(agentName, animKey, options = {}) {
    const debug = typeof window !== 'undefined' && window.TRADING_FLOOR_DEBUG === true
    if (debug) {
      console.log(`[TradingFloorScene] playAnimation: agentName="${agentName}", animKey="${animKey}"`)
      console.log('[TradingFloorScene] animController exists:', !!this.animController)
      console.log('[TradingFloorScene] agent exists:', !!this.agents[agentName])
    }
    
    if (this.animController && this.agents[agentName]) {
      if (debug) console.log(`[TradingFloorScene] Using AnimationController for "${agentName}"`)
      return this.animController.play(agentName, animKey, options)
    }
    // Fallback to direct play
    const agent = this.agents[agentName]
    if (agent) {
      const key = `agent_${agentName.toLowerCase()}_${animKey}`
      if (debug) console.log(`[TradingFloorScene] Fallback: playing "${key}" directly`)
      agent.play(key, true)
    } else {
      if (debug) console.warn(`[TradingFloorScene] Agent "${agentName}" not found, available:`, Object.keys(this.agents))
    }
    return false
  }

  /**
   * Reset agent to idle state
   * @param {string} agentName - Agent name
   */
  resetAgent(agentName) {
    if (this.animController) {
      this.animController.reset(agentName)
    } else {
      const agent = this.agents[agentName]
      if (agent) {
        const key = `agent_${agentName.toLowerCase()}_idle`
        agent.play(key, true)
      }
    }
  }

  /**
   * Handle scene data from scriptwriter - moves agents and plays dialogue
   * @param {Object} scene - Scene data with agent1, agent2, location, dialogue
   */
  handleSceneAgents(scene) {
    const { agent1, agent2, location } = scene

    // Move agents to location
    if (agent1) this.moveAgentToStation(agent1, location || 'cooler', MovePriority.AUTOMATED, 'scene:handleSceneAgents')
    if (agent2) this.moveAgentToStation(agent2, location || 'cooler', MovePriority.AUTOMATED, 'scene:handleSceneAgents')

    // Play scene dialogue with transitions
    this.playSceneDialogue(scene)
  }

  /**
   * Play scene dialogue with smooth animation transitions
   * @param {Object} scene - Scene data
   */
  async playSceneDialogue(scene) {
    const { agent1, agent1_line, agent2, agent2_line } = scene

    // Agent 1 speaks
    await this.delay(1000)
    if (agent1 && agent1_line) {
      this.playAnimation(agent1, AnimStateType.TALK, { blendDuration: 200 })
      this.showSpeechBubble(this.agents[agent1], agent1_line, 4000)
    }

    // Agent 2 responds
    await this.delay(4500)
    if (agent2 && agent2_line) {
      this.playAnimation(agent2, AnimStateType.TALK, { blendDuration: 200 })
      this.showSpeechBubble(this.agents[agent2], agent2_line, 4000)
    }

    // Return to idle
    await this.delay(5000)
    if (agent1) this.resetAgent(agent1)
    if (agent2) this.resetAgent(agent2)
  }

  /**
   * Helper delay function
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => {
      this.time.delayedCall(ms, resolve)
    })
  }

  /**
   * Subscribe to animation events
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  onAnimationEvent(event, callback) {
    if (this.animController) {
      return this.animController.on(event, callback)
    }
    return () => { }
  }

  /**
   * Get animation controller statistics
   */
  getAnimationStats() {
    return this.animController ? this.animController.getStats() : null
  }

  /**
   * Move multiple agents to a gathering location for gossip scenes
   * Uses pre-cached spots - NO map loops during live events
   * @param {string[]} agentNames - Array of agent names
   * @param {string} location - Location type ('cooler' or 'table')
   */
  moveAgentsToLocation(agentNames, location) {
    const roomMap = this.getRoomMap()
    const spots = this.getGatherSpots(location)
    if (!spots || !agentNames?.length) return

    agentNames.forEach((name, idx) => {
      // Map short name to full agent name
      const fullName = resolveAgentName(name)
      const agent = this.agents[fullName]
      if (!agent) {
        console.warn(`Agent not found: ${name} (tried: ${fullName})`)
        return
      }

      // Assign unique spot (modulo for safety if more agents than spots)
      const target = spots[idx % spots.length]
      const pos = getGridPos(agent.x, agent.y)

      // Get reserved tiles for collision avoidance
      const reservedTiles = this.showrunner?.reservedTiles || null
      const path = findPathToCoord(roomMap, pos.c, pos.r, target.c, target.r, reservedTiles, fullName)

      if (path) {
        // Reserve destination
        if (this.showrunner) {
          this.showrunner.reserveTile(target.c, target.r, fullName)
        }
        this.startPathMovement(agent, path, () => {
          // Release reservation
          if (this.showrunner) {
            this.showrunner.releaseTile(target.c, target.r)
          }
          // Face the center of the gathering
          this.faceTarget(agent, spots[0])
          this.playAnimation(fullName, AnimStateType.TALK, { blendDuration: 200 })
        })
      }
    })
  }

  /**
   * Make agent face a target position
   * @param {Phaser.GameObjects.Sprite} agent - The agent sprite
   * @param {{c: number, r: number}} targetPos - Target grid position
   */
  faceTarget(agent, targetPos) {
    const agentGrid = getGridPos(agent.x, agent.y)
    const dx = targetPos.c - agentGrid.c
    const dy = targetPos.r - agentGrid.r

    // In this art set we only have horizontal flipping for conversation-facing.
    // Keep facing deterministic for rally/table scenes by deriving a horizontal
    // direction even when the primary offset is vertical.
    if (dx !== 0) {
      agent.setFlipX(dx < 0)
      return
    }
    if (dy !== 0) {
      // Center-column fallback so top/bottom seats still orient consistently.
      agent.setFlipX(dy > 0)
    }
  }

  /**
   * Return agents to their home positions after gossip
   * Called by React when Typewriter finishes
   * @param {string[]} agentNames - Array of agent names
   */
  returnAgentsToDesks(agentNames) {
    const roomMap = this.getRoomMap()
    agentNames?.forEach(name => {
      // Map short name to full agent name
      const fullName = resolveAgentName(name)
      const agent = this.agents[fullName]
      if (!agent?.homePos) return

      const pos = getGridPos(agent.x, agent.y)

      // Get reserved tiles for collision avoidance
      const reservedTiles = this.showrunner?.reservedTiles || null
      const path = findPathToCoord(roomMap, pos.c, pos.r, agent.homePos.c, agent.homePos.r, reservedTiles, fullName)

      if (path) {
        // Reserve home position
        if (this.showrunner) {
          this.showrunner.reserveTile(agent.homePos.c, agent.homePos.r, fullName)
        }
        this.startPathMovement(agent, path, () => {
          // Release reservation
          if (this.showrunner) {
            this.showrunner.releaseTile(agent.homePos.c, agent.homePos.r)
          }
          this.resetAgent(fullName)
        })
      }
    })
  }

  getGatherSpots(location) {
    const dynamicSpots = this.gatherSpotsDynamic?.[location]
    if (Array.isArray(dynamicSpots) && dynamicSpots.length > 0) {
      return dynamicSpots
    }
    return GATHER_SPOTS[location]
  }

  refreshGatherSpots() {
    const roomMap = this.getRoomMap()
    const gather = {}
    const stationKeys = Object.keys(STATION_TILE_MAP).filter((key) => key !== 'desk')
    stationKeys.forEach((station) => {
      const tileType = STATION_TILE_MAP[station]
      const spots = new Set()
      for (let r = 0; r < roomMap.length; r++) {
        for (let c = 0; c < roomMap[0].length; c++) {
          if (roomMap[r][c] !== tileType) continue
          const neighbors = [
            { c: c + 1, r }, { c: c - 1, r },
            { c, r: r + 1 }, { c, r: r - 1 },
            { c: c + 1, r: r + 1 }, { c: c - 1, r: r - 1 },
            { c: c + 1, r: r - 1 }, { c: c - 1, r: r + 1 }
          ]
          neighbors.forEach((n) => {
            if (isWalkable(n.c, n.r, null, null, roomMap)) spots.add(`${n.c},${n.r}`)
          })
        }
      }
      gather[station] = Array.from(spots)
        .map((key) => {
          const [c, r] = key.split(',').map(Number)
          return { c, r }
        })
        .sort((a, b) => (a.r - b.r) || (a.c - b.c))
    })
    this.gatherSpotsDynamic = gather
  }

  // ============================================
  // ANNOTATION SYSTEM (Canvas Drawing Tools)
  // ============================================

  /**
   * Setup canvas pointer input handlers.
   * Blueprint tools still only activate while blueprint mode is enabled,
   * and live canvas click-to-rally is available in all runtime modes.
   */
  setupBlueprintMode() {
    if (this.blueprintInputSetup) return

    this.annotationDragStart = null
    this.annotationCurrentPoints = []
    this.selectedAgentForDrag = null
    this.isPaintingMap = false

    // Enable pointer input
    this.input.on('pointerdown', this.handleAnnotationPointerDown, this)
    this.input.on('pointermove', this.handleAnnotationPointerMove, this)
    this.input.on('pointerup', (_pointer) => { this.handleAnnotationPointerUp(_pointer) }, this)

    this.blueprintInputSetup = true
    console.log('[TradingFloorScene] Annotation input handlers setup')
  }

  /**
   * Handle pointer down based on current annotation tool
   */
  handleAnnotationPointerDown(pointer) {
    const { x, y } = this.getPointerScenePosition(pointer)

    if (!this.showrunner?.blueprintMode) {
      this.showrunner?.rallyAllAgentsToPointer?.(x, y)
      return
    }

    const tool = this.showrunner.annotationTool

    switch (tool) {
      case 'pen':
        this.startPenDrawing(x, y)
        break
      case 'circle':
        this.startCircleDrawing(x, y)
        break
      case 'eraser':
        this.handleEraserTool(x, y)
        break
      default:
        // Unknown tool - do nothing
        break
    }
  }

  /**
   * Handle pointer move based on current annotation tool
   */
  handleAnnotationPointerMove(pointer) {
    if (!this.showrunner?.blueprintMode) return

    const { x, y } = this.getPointerScenePosition(pointer)
    const tool = this.showrunner.annotationTool

    switch (tool) {
      case 'pen':
        this.updatePenDrawing(x, y)
        break
      case 'circle':
        this.updateCircleDrawing(x, y)
        break
      case 'eraser':
        // Eraser doesn't need move handling
        break
      default:
        // Unknown tool - do nothing
        break
    }
  }

  /**
   * Handle pointer up based on current annotation tool
   */
  handleAnnotationPointerUp(pointer) {
    if (!this.showrunner?.blueprintMode) return

    const { x, y } = this.getPointerScenePosition(pointer)
    const tool = this.showrunner.annotationTool

    switch (tool) {
      case 'pen':
        this.finishPenDrawing()
        break
      case 'circle':
        this.finishCircleDrawing(x, y)
        break
      case 'select':
        this.finishSelectDrag()
        break
      case 'eraser':
        // Eraser doesn't need up handling
        break
      default:
        // Unknown tool - do nothing
        break
    }
  }

  // ============================================
  // PEN TOOL
  // ============================================

  startPenDrawing(x, y) {
    this.annotationDragStart = { x, y }
    this.annotationCurrentPoints = [{ x, y }]
  }

  getPointerScenePosition(pointer) {
    return {
      x: Number.isFinite(pointer?.worldX) ? pointer.worldX : pointer?.x || 0,
      y: Number.isFinite(pointer?.worldY) ? pointer.worldY : pointer?.y || 0,
    }
  }

  updatePenDrawing(x, y) {
    if (!this.annotationDragStart) return

    // Add point to current stroke
    this.annotationCurrentPoints.push({ x, y })

    // Draw preview
    this.drawAnnotationPreview()
  }

  finishPenDrawing() {
    if (this.annotationCurrentPoints.length < 2) {
      this.annotationDragStart = null
      this.annotationCurrentPoints = []
      return
    }

    // Save the annotation
    this.showrunner.addAnnotation(
      'pen',
      [...this.annotationCurrentPoints],
      this.showrunner.annotationColor,
      this.showrunner.annotationWidth
    )

    // Reset state
    this.annotationDragStart = null
    this.annotationCurrentPoints = []

    // Clear preview
    if (this.blueprintPreviewGraphics) {
      this.blueprintPreviewGraphics.clear()
    }
  }

  // ============================================
  // CIRCLE TOOL
  // ============================================

  startCircleDrawing(x, y) {
    this.annotationDragStart = { x, y }
    this.annotationCurrentPoints = [{ x, y }] // Center point
  }

  updateCircleDrawing(x, y) {
    if (!this.annotationDragStart) return

    // Draw circle preview
    this.drawCirclePreview(this.annotationDragStart.x, this.annotationDragStart.y, x, y)
  }

  finishCircleDrawing(x, y) {
    if (!this.annotationDragStart) return

    const center = this.annotationDragStart
    const edge = { x, y }
    const radius = Math.sqrt((edge.x - center.x) ** 2 + (edge.y - center.y) ** 2)

    if (radius > 5) {
      // Save the circle annotation
      this.showrunner.addAnnotation(
        'circle',
        [center, edge],
        this.showrunner.annotationColor,
        this.showrunner.annotationWidth
      )

      // Find agents within the circle
      const agentsInCircle = this.showrunner.findAgentsInCircle(center.x, center.y, radius)
      if (agentsInCircle.length > 0) {
        this.showrunner.selectedAgents = agentsInCircle
        this.showrunner.drawAnnotations()
        console.log('[TradingFloorScene] Selected agents:', agentsInCircle)
      }
    }

    // Reset state
    this.annotationDragStart = null
    this.annotationCurrentPoints = []

    // Clear preview
    if (this.blueprintPreviewGraphics) {
      this.blueprintPreviewGraphics.clear()
    }
  }

  drawCirclePreview(cx, cy, ex, ey) {
    if (!this.blueprintPreviewGraphics) {
      this.blueprintPreviewGraphics = this.add.graphics()
      this.blueprintPreviewGraphics.setDepth(9999)
    }

    const graphics = this.blueprintPreviewGraphics
    graphics.clear()

    const radius = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2)
    const color = this.showrunner.hexStringToNumber(this.showrunner.annotationColor)

    graphics.lineStyle(this.showrunner.annotationWidth, color, 0.8)
    graphics.strokeCircle(cx, cy, radius)
  }

  // ============================================
  // SELECT TOOL
  // ============================================

  handleSelectTool(x, y, _pointer) {
    // Check if clicking on an agent
    const agentName = this.showrunner.findAgentAtPoint(x, y)

    if (agentName) {
      // Select this agent for dragging
      this.selectedAgentForDrag = agentName
      this.annotationDragStart = { x, y }
      this.showrunner.selectedAgents = [agentName]
      this.showrunner.drawAnnotations()
      console.log('[TradingFloorScene] Selected agent for drag:', agentName)
    } else {
      // Clear selection
      this.showrunner.selectedAgents = []
      this.showrunner.drawAnnotations()
    }
  }

  updateSelectDrag(x, y) {
    if (!this.selectedAgentForDrag || !this.annotationDragStart) return

    // Move the selected agent
    const agent = this.agents[this.selectedAgentForDrag]
    if (agent) {
      agent.x = x
      agent.y = y
      this.showrunner.drawAnnotations()
    }
  }

  finishSelectDrag() {
    this.selectedAgentForDrag = null
    this.annotationDragStart = null
  }

  // ============================================
  // ERASER TOOL
  // ============================================

  handleEraserTool(x, y) {
    // Remove annotation at this point
    this.showrunner.removeAnnotationAt(x, y)
  }

  // ============================================
  // MAP EDITOR TOOLS (Replaced by ASCII Editor)
  // ============================================

  rerenderRoom() {
    if (this.pendingRoomRerender) return
    this.pendingRoomRerender = true

    // Give textures a moment to swap in WebGL memory
    this.time.delayedCall(50, () => {
      // 1. Destroy existing static room elements
      if (this.roomSprites) {
        this.roomSprites.forEach(sprite => {
          if (sprite && sprite.destroy) sprite.destroy()
        })
      }
      this.roomSprites = []

      // 2. Destroy ambient particles
      if (this.particles) {
        this.particles.forEach(p => {
          if (p.sprite && p.sprite.destroy) p.sprite.destroy()
        })
      }
      this.particles = []

      // 3. Rebuild the room with the newly generated textures
      this.buildRoom()

      // Redraw debug grid if it exists
      if (this.debugGridGraphics) {
        this.debugGridGraphics.destroy()
        this.debugGridGraphics = null
        this.drawDebugGrid()
      }
      this.pendingRoomRerender = false
    })
  }

  exportRoomMap() {
    const roomMap = this.getRoomMap()
    let output = "export const ROOM_MAP = [\n"
    for (let r = 0; r < roomMap.length; r++) {
      output += "  [" + roomMap[r].join(", ") + "]" + (r === roomMap.length - 1 ? "" : ",") + "\n"
    }
    output += "]"

    // Copy to clipboard
    navigator.clipboard.writeText(output).then(() => {
      alert("ROOM_MAP JSON copied to clipboard! Paste it directly into your constants.js file.")
    }).catch(err => {
      console.error("Failed to copy map structure", err)
      alert("Failed to copy. Map structure logged to console instead.")
      console.log(output)
    })
  }

  // ============================================
  // PREVIEW DRAWING
  // ============================================

  drawAnnotationPreview() {
    if (!this.blueprintPreviewGraphics) {
      this.blueprintPreviewGraphics = this.add.graphics()
      this.blueprintPreviewGraphics.setDepth(9999)
    }

    const graphics = this.blueprintPreviewGraphics
    graphics.clear()

    if (this.annotationCurrentPoints.length < 2) return

    const color = this.showrunner.hexStringToNumber(this.showrunner.annotationColor)
    const width = this.showrunner.annotationWidth

    graphics.lineStyle(width, color, 1)
    graphics.beginPath()
    graphics.moveTo(this.annotationCurrentPoints[0].x, this.annotationCurrentPoints[0].y)

    for (let i = 1; i < this.annotationCurrentPoints.length; i++) {
      graphics.lineTo(this.annotationCurrentPoints[i].x, this.annotationCurrentPoints[i].y)
    }

    graphics.strokePath()
  }
}
