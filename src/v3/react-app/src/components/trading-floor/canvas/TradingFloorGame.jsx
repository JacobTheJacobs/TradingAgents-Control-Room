import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react'
import PropTypes from 'prop-types'
import Phaser from 'phaser'
import { TradingFloorScene } from './TradingFloorScene'
import { getIdleBehaviorEngine } from './animators/IdleBehaviorEngine'
import { useTradingFloor } from '../../../context/TradingFloorContext'
import { normalizeTradingAgentId } from '../../../config/tradingAgentsRoster'
import './canvas.css'

export const TradingFloorGame = forwardRef(({ mode = 'obs', lightMode = 'day', onSceneReady = null }, ref) => {
  const containerRef = useRef(null)
  const gameRef = useRef(null)
  const latestSizeRef = useRef({ width: 0, height: 0 })
  const [isReady, setIsReady] = useState(false)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

  const { state } = useTradingFloor()
  const sentiment = state.sentiment?.aggregate?.sentiment || 0

  // 1. Expose imperative API for animations
  useImperativeHandle(ref, () => ({
    playErrorAnimation: (agentName, animationName) => {
      const scene = window.PHASER_SCENE
      if (scene) {
        const engine = getIdleBehaviorEngine(scene)
        if (engine) engine.playErrorAnimation(agentName, animationName)
      }
    }
  }))

  // 2. Sync sentiment to scene registry/property
  useEffect(() => {
    const scene = window.PHASER_SCENE
    if (scene) {
      scene.sentiment = sentiment
    }
  }, [sentiment])

  // 3. Highlight active agents based on pipeline tracking
  const activeAgentKey = normalizeTradingAgentId(
    state.pipelineState?.current_step ||
    state.pipelineState?.agent_display_name ||
    state.pipelineState?.agent
  );
  const activePhase = state.pipelineState?.phase;
  const isRunning = state.taRunStats?.running;

  useEffect(() => {
    const scene = window.PHASER_SCENE
    if (!scene || typeof scene.highlightAgents !== 'function') return;

    if (!isRunning) {
      scene.highlightAgents([]); // Clear highlights
      return;
    }

    if (activePhase === 'researchers') {
      // Bull & Bear are researching
      scene.highlightAgents(['bull_researcher', 'bear_researcher']);
    } else if (activePhase === 'risk') {
      // Aggr, Cons, Neutral, Risk Judge are discussing risk
      scene.highlightAgents(['aggressive_analyst', 'conservative_analyst', 'neutral_analyst', 'risk_judge']);
    } else if (activeAgentKey) {
      scene.highlightAgents([activeAgentKey]);
    } else {
      scene.highlightAgents([]);
    }
  }, [activeAgentKey, activePhase, isRunning]);

  // 3. Monitor container size - Phaser WebGL requires non-zero dimensions
  useEffect(() => {
    if (!containerRef.current) return

    const commitSize = (rawWidth, rawHeight) => {
      const width = Math.max(1, Math.round(rawWidth || 0))
      const height = Math.max(1, Math.round(rawHeight || 0))
      if (width <= 0 || height <= 0) return

      const previous = latestSizeRef.current
      if (previous.width === width && previous.height === height) return

      latestSizeRef.current = { width, height }
      setDimensions({ width, height })
      setIsReady(true)
    }

    const checkSize = () => {
      const { clientWidth, clientHeight } = containerRef.current
      commitSize(clientWidth, clientHeight)
    }

    checkSize()

    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect
        commitSize(width, height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // 4. Initialize Game once container has valid dimensions
  useEffect(() => {
    if (!isReady || gameRef.current) return

    const config = {
      // The trading floor is a 2D pixel-art scene. Forcing Canvas avoids
      // Phaser's WebGL framebuffer-resize failures on some browsers/GPUs.
      type: Phaser.CANVAS,
      parent: containerRef.current,
      width: dimensions.width || 640,
      height: dimensions.height || 448,
      backgroundColor: '#000000',
      resolution: 1,
      autoRound: true,
      pixelArt: true,
      antialias: false,
      roundPixels: true,
      physics: {
        default: 'arcade',
        arcade: { debug: false }
      },
      audio: {
        noAudio: true,
      },
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [TradingFloorScene]
    }

    try {
      const newGame = new Phaser.Game(config)
      gameRef.current = newGame
      window.PHASER_GAME = newGame

      const pixelConfig = newGame?.config || {}
      if (!pixelConfig.pixelArt || pixelConfig.antialias || !pixelConfig.roundPixels) {
        console.warn('[Phaser] Pixel settings mismatch:', {
          pixelArt: pixelConfig.pixelArt,
          antialias: pixelConfig.antialias,
          roundPixels: pixelConfig.roundPixels
        })
      }

      // Registry initialization
      newGame.registry.set('mode', mode)
      newGame.registry.set('lightMode', lightMode)

      // Bridge for external interaction
      newGame.events.on('ready', () => {
        const scene = newGame.scene.getScene('TradingFloorScene')
        window.PHASER_SCENE = scene
        if (onSceneReady) onSceneReady(scene)
      })

      return () => {
        if (newGame) {
          newGame.destroy(true)
        }
        gameRef.current = null
        window.PHASER_GAME = null
        window.PHASER_SCENE = null
      }
    } catch (err) {
      console.error('Phaser Initialization Failed:', err)
    }
  }, [isReady, mode, lightMode, onSceneReady])

  // 5. Sync lightMode changes to scene
  useEffect(() => {
    if (gameRef.current) {
      gameRef.current.registry.set('lightMode', lightMode)
      const scene = gameRef.current.scene.getScene('TradingFloorScene')
      if (scene && scene.updateLighting) {
        scene.updateLighting(lightMode)
      }
    }
  }, [lightMode])

  return (
    <div 
      ref={containerRef} 
      className="tf-game-container"
      style={{ 
        width: '100%', 
        height: '100%', 
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      {!isReady && (
        <div style={{ 
          color: '#4ade80', 
          fontFamily: 'monospace', 
          fontSize: '12px',
          textAlign: 'center',
          padding: '20px',
          border: '1px solid #4ade80',
          backgroundColor: 'rgba(0,0,0,0.8)',
          zIndex: 10
        }}>
          INITIALIZING TACTICAL MAP...
          <br/>
          <span style={{ fontSize: '10px', opacity: 0.7 }}>WAITING FOR DOM CALIBRATION</span>
        </div>
      )}
    </div>
  )
})

TradingFloorGame.displayName = 'TradingFloorGame'

TradingFloorGame.propTypes = {
  mode: PropTypes.oneOf(['obs', 'admin']),
  lightMode: PropTypes.oneOf(['day', 'night']),
  onSceneReady: PropTypes.func
}
