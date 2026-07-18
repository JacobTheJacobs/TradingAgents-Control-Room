// Trading Floor Page - Main Orchestrator Component (Refactored)
import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import PropTypes from 'prop-types'
import { TradingFloorGame } from './canvas/TradingFloorGame'
import { DialogueBoxPanel } from './panels/DialogueBoxPanel'
import FinalReportsPanel from './panels/FinalReportsPanel'
import { TradePanel } from '../admin/TradePanel'
import { RunsPanel } from '../admin/RunsPanel'
// import { PhaseLighting } from './ui/PhaseLighting'

import MetroFlow from '../MetroFlow'
import { AnimatePresence, motion } from 'framer-motion'
import { useTradingFloor } from '../../context/TradingFloorContext'
import { getPhaseLightingCSS } from '../../utils/spriteBehaviors'
import { getIdleBehaviorEngine } from './canvas/animators/IdleBehaviorEngine'
import { StepSceneController } from '../steps/StepSceneController'
import '../TradingFloorPage.css'

const SCENE_DIRECTOR_TABS = ['Trade', 'Final Reports', 'History Runs']

function TradingFloorPageContent({
  mode = 'obs',
  isCanvasFullscreen = false,
  propPortfolio = {},
  currentTicker = null,
  connected = false,
  forceReconnect = null,
  pipelinePhase = 'idle',
  regime = null,
  stepScript = null,
  stepScriptMeta = null,
  tickerQueue = [],
  pipelineHistory = [],
  hideNews: propHideNews,
  hideCycle: propHideCycle,
  hideLeftSidebar: propHideLeftSidebar,
  hideRightSidebar: propHideRightSidebar,
}) {
  // Set global mode for Phaser scene (Ghost Layer)
  useEffect(() => {
    window.TRADING_FLOOR_MODE = mode
  }, [mode])

  const { 
    state
  } = useTradingFloor()

  // ── Local state for UI feedback ──
  const [toasts] = useState([])
  const [activeReportTab, setActiveReportTab] = useState('Trade')

  // Extract from state for local use
  const { 
    hideNews: contextHideNews, 
    hideCycle: contextHideCycle, 
    hideLeftSidebar: contextHideLeftSidebar,
    hideRightSidebar: contextHideRightSidebar 
  } = state

  // Use props if provided explicitly (admin preview), otherwise use global context
  const hideNews = propHideNews !== undefined ? propHideNews : contextHideNews;
  const hideCycle = propHideCycle !== undefined ? propHideCycle : contextHideCycle;
  const hideLeftSidebar = true;
  const hideRightSidebar = propHideRightSidebar !== undefined ? propHideRightSidebar : contextHideRightSidebar;

  const phase = state.schedulePhase || 'trading_hours'
  const sceneRef = useRef(null)
  const containerRef = useRef(null)

  // Handle scene ready
  const handleSceneReady = useCallback((scene) => {
    sceneRef.current = scene
    const idleEngine = getIdleBehaviorEngine(scene)
    idleEngine.start()
  }, [])

  // Sync idle engine phase
  useEffect(() => {
    if (sceneRef.current && phase) {
      const idleEngine = getIdleBehaviorEngine(sceneRef.current)
      idleEngine.setSchedulePhase(phase)
    }
  }, [phase])

  // Merge pipeline logs with activity logs for the console and dialogue views.
  const allLogs = useMemo(() => {
    const pipelineStateHistory = Array.isArray(state.pipelineState?.history) ? state.pipelineState.history : [];
    const propHistory = Array.isArray(pipelineHistory) ? pipelineHistory : [];
    const currentHist = pipelineStateHistory.length > 0 ? pipelineStateHistory : propHistory;

    const formatPipelineMessage = (msg) => {
      const phaseLabel = msg.sub_phase || msg.phase;
      const phaseStr = phaseLabel ? `[${String(phaseLabel).toUpperCase()}] ` : '';
      const agentStr = msg.agent ? `${msg.agent}: ` : '';
      const tickerStr = msg.ticker ? `$${msg.ticker} ` : '';
      const reportBody = msg.report || msg.raw_excerpt || '';

      if (reportBody) {
        const header = `${phaseStr}${agentStr}${tickerStr}`.trim();
        return header ? `${header}\n${reportBody}` : reportBody;
      }

      const actionStr = msg.message || msg.action || msg.decision || msg.result || msg.output || '';
      return `${phaseStr}${agentStr}${tickerStr}${actionStr}`.trim() || 'Pipeline event received';
    };

    const pipelineLogs = currentHist.slice(-150).map(msg => ({
      ...msg,
      type: msg.type?.toUpperCase() || 'SYSTEM',
      message: formatPipelineMessage(msg),
      timestamp: msg.timestamp,
      raw_excerpt: msg.report || msg.raw_excerpt || null,
      source: msg.source || 'pipeline_event',
    }));

    const seen = new Set();

    return [...state.logs, ...pipelineLogs]
      .filter(log => {
        const fingerprint = [
          log.type,
          log.agent,
          log.phase,
          log.timestamp,
          log.message,
        ].join('|');

        if (seen.has(fingerprint)) {
          return false;
        }

        seen.add(fingerprint);
        return true;
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 100);
  }, [state.logs, pipelineHistory, state.pipelineState])

  if (isCanvasFullscreen) {
    return (
      <div className="obs-container--fullscreen">
        <div className="tf-game-wrapper tf-game-wrapper--fullscreen" style={{ ...getPhaseLightingCSS(phase) }} ref={containerRef}>
          <TradingFloorGame mode={mode} lightMode={state.lightMode} onSceneReady={handleSceneReady} />
        </div>
      </div>
    )
  }

  const layoutStyle = {
    height: '100%',
    flex: 1,
  }

  const handleReportTabClick = useCallback((tab) => {
    setActiveReportTab(tab)
  }, [])

  const renderRightPanelContent = useCallback(() => {
    switch (activeReportTab) {
      case 'Trade':
        return <TradePanel stepScript={stepScript} stepScriptMeta={stepScriptMeta} />
      case 'History Runs':
        return <RunsPanel />
      case 'Final Reports':
      default:
        return <FinalReportsPanel tabLabel={activeReportTab} />
    }
  }, [activeReportTab, connected, forceReconnect, stepScript, stepScriptMeta])

  return (
    <div className={`obs-container lean-swarm-layout ${state.lightMode === 'day' ? 'light-mode' : ''} ${hideNews ? 'hide-news' : ''} ${hideCycle ? 'hide-cycle-banner' : ''} ${hideLeftSidebar ? 'hide-left-sidebar' : ''} ${hideRightSidebar ? 'hide-right-sidebar' : ''}`} style={layoutStyle}>
      {/* 1. LEFT SIDEBAR removed */}

      <div className="obs-marquee obs-panel" aria-label="Trading floor marquee">
        <div className="marquee-panel">
          <div className="marquee-content">
            <span className="marquee-scroll">{state.marqueeText || 'TRADING AGENT NOW RUNNING NEWS'}</span>
            <span className="marquee-scroll">{state.marqueeText || 'TRADING AGENT NOW RUNNING NEWS'}</span>
            <span className="marquee-scroll">{state.marqueeText || 'TRADING AGENT NOW RUNNING NEWS'}</span>
          </div>
        </div>
      </div>

      <div className="obs-queue-tabs obs-panel" aria-label="Final reports tabs">
        <div className="obs-queue-tabs__bar">
          {SCENE_DIRECTOR_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`obs-queue-tabs__btn ${activeReportTab === tab ? 'is-active' : ''}`}
              onClick={() => handleReportTabClick(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* 2. CENTER: Trading Floor Canvas */}
      <div className="obs-main obs-panel" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        
        {/* CLASSIC CYCLE MONITOR - Visible when hideCycle is false */}
        <AnimatePresence>
          {!hideCycle && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
              className="metroflow-wrapper"
              style={{ width: '100%', marginBottom: '8px' }}
            >
              <MetroFlow 
                source={state.pipelineState.source || 'pipeline'}
                researchDepth={state.pipelineState.researchDepth || 'standard'}
                pipelinePhase={state.pipelineState.phase} 
                currentAction={state.pipelineState.action}
                cycle={state.pipelineState.cycle || 0}
                currentTicker={state.pipelineState.current_ticker || state.pipelineState.ticker}
                agentStates={state.agentStates}
                compact={false}
                startTime={state.pipelineState.start_time}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="tf-game-wrapper" style={{ ...getPhaseLightingCSS(phase, state.lightMode), width: '100%', flex: 1 }} ref={containerRef}>
          <TradingFloorGame mode={mode} lightMode={state.lightMode} onSceneReady={handleSceneReady} />
          
          <StepSceneController
            pipelinePhase={state.pipelineState?.phase || pipelinePhase}
            regime={state.pipelineState?.regime || regime}
            ticker={state.pipelineState?.ticker || currentTicker}
            portfolio={state.portfolio || propPortfolio}
            stepScript={stepScript}
            stepScriptMeta={stepScriptMeta}
            enabled={(mode === 'obs' || mode === 'admin') && !state.taRunStats?.running && state.pipelineState?.pipeline_mode !== 'tradingagents'}
          />

          <div className="tf-toasts">
            {toasts.map(t => (
              <div key={t.id} className={`tf-toast tf-toast--${t.type}`}>
                <div className="tf-toast__title">{t.title} {t.ticker && <span className="tf-toast__ticker">{t.ticker}</span>}</div>
                <div className="tf-toast__message">{t.message}</div>
              </div>
            ))}
          </div>
        </div>

        {/* JRPG TERMINAL - Centered below canvas */}
        <div className="jrpg-terminal-container">
          <DialogueBoxPanel 
            currentTicker={state.pipelineState?.ticker || currentTicker}
            pipelinePhase={state.pipelineState?.phase || pipelinePhase}
            sceneRef={sceneRef}
            logs={allLogs}
          />
        </div>
      </div>

      {/* 3. RIGHT SIDEBAR: Agent Swarm Status + Final Reports */}
      <div
        className={`obs-queue obs-panel ${activeReportTab === 'Trade' ? 'obs-queue--trade-active' : ''}`}
        style={{ display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        <div
          className="obs-queue-content"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: activeReportTab === 'Trade' ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {renderRightPanelContent()}
        </div>
      </div>

    </div>
  )
}

TradingFloorPageContent.propTypes = {
  mode: PropTypes.oneOf(['obs', 'admin']),
  portfolio: PropTypes.object,
  currentTicker: PropTypes.string,
  connected: PropTypes.bool,
  forceReconnect: PropTypes.func,
  pipelinePhase: PropTypes.string,
  regime: PropTypes.string,
  stepScript: PropTypes.object,
  stepScriptMeta: PropTypes.object,
  tickerQueue: PropTypes.array,
  pipelineHistory: PropTypes.array,
  hideNews: PropTypes.bool,
  hideCycle: PropTypes.bool,
  hideLeftSidebar: PropTypes.bool,
  hideRightSidebar: PropTypes.bool,
}

export default function TradingFloorPage(props) {
  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: 'var(--bg-card)', display: 'flex', overflow: 'hidden' }}>
      <TradingFloorPageContent mode={props.mode || 'obs'} {...props} cycle={props.cycle || 0} />
    </div>
  )
}

export { TradingFloorPageContent }
