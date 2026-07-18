/**
 * TAStatusBar - TradingAgents Progress Tracker
 * 
 * Replaces MetroFlow cycle view when in TradingAgents mode.
 * Shows: Agents count, LLM calls, Tools, Tokens, Reports progress, Timer
 */
import { useState, useEffect, useMemo } from 'react'
import { useTradingFloor } from '../context/TradingFloorContext'
import { TRADING_AGENT_REPORT_CARD_DEFS } from '../config/tradingAgentsRoster'
import './TAStatusBar.css'

const REPORT_DOT_META = {
  market_analyst: { icon: '📊' },
  social_analyst: { icon: '🙂' },
  news_analyst: { icon: '📰' },
  fundamentals_analyst: { icon: '📋' },
  bull_researcher: { icon: '🐂' },
  bear_researcher: { icon: '🐻' },
  research_manager: { icon: '🧭' },
  trader: { icon: '⚡' },
  aggressive_analyst: { icon: '⬆' },
  conservative_analyst: { icon: '⬇' },
  neutral_analyst: { icon: '⚖' },
  risk_judge: { icon: '🏦' },
}

export default function TAStatusBar({ ticker = '', compact = false }) {
  const { state } = useTradingFloor()
  const { taRunStats, pipelineState } = state
  const tickerFromRunId = (runId = '') => {
    const value = String(runId || '')
    if (!value) return ''
    const match = value.match(/^ta-([A-Za-z0-9._-]+)-/)
    return match?.[1]?.toUpperCase() || ''
  }

  const toFiniteNumber = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  const resolveElapsedSeconds = ({ startTime, endTime, explicitElapsed, running }) => {
    const explicit = toFiniteNumber(explicitElapsed)
    if (!running && explicit != null && explicit >= 0) return Math.round(explicit)

    const startMs = Date.parse(startTime || '')
    if (!Number.isFinite(startMs)) return explicit != null && explicit >= 0 ? Math.round(explicit) : 0

    const endMs = running
      ? Date.now()
      : (Date.parse(endTime || '') || Date.now())
    const elapsedSec = Math.floor((endMs - startMs) / 1000)
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0) {
      return explicit != null && explicit >= 0 ? Math.round(explicit) : 0
    }
    return elapsedSec
  }

  const resolvedTokensUp = Math.max(
    toFiniteNumber(taRunStats.tokensUp) ?? 0,
    toFiniteNumber(pipelineState?.tokens_in) ?? 0,
  )
  const resolvedTokensDown = Math.max(
    toFiniteNumber(taRunStats.tokensDown) ?? 0,
    toFiniteNumber(pipelineState?.tokens_out) ?? 0,
  )

  // Timer
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!taRunStats.startTime || !taRunStats.running) {
      setElapsed(resolveElapsedSeconds({
        startTime: taRunStats.startTime,
        endTime: taRunStats.endTime || taRunStats.upstreamGeneratedAt || pipelineState?.timestamp,
        explicitElapsed: taRunStats.elapsed,
        running: Boolean(taRunStats.running),
      }))
      return
    }
    const updateElapsed = () => {
      const nextElapsed = resolveElapsedSeconds({
        startTime: taRunStats.startTime,
        endTime: null,
        explicitElapsed: taRunStats.elapsed,
        running: true,
      })
      setElapsed(Number.isFinite(nextElapsed) && nextElapsed >= 0 ? nextElapsed : 0)
    }
    updateElapsed()
    const interval = setInterval(() => {
      updateElapsed()
    }, 1000)
    return () => clearInterval(interval)
  }, [taRunStats.startTime, taRunStats.endTime, taRunStats.running, taRunStats.elapsed, taRunStats.upstreamGeneratedAt, pipelineState?.timestamp])

  const formatTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const formatTokens = (up, down) => {
    if ((up == null || Number.isNaN(Number(up))) && (down == null || Number.isNaN(Number(down)))) return '--'
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n
    const upValue = Number.isFinite(Number(up)) ? Number(up) : 0
    const downValue = Number.isFinite(Number(down)) ? Number(down) : 0
    return `${fmt(upValue)}↑ ${fmt(downValue)}↓`
  }

  const displayTicker =
    String(
      pipelineState?.ticker ||
      pipelineState?.current_ticker ||
      ticker ||
      tickerFromRunId(taRunStats?.runId) ||
      ''
    ).toUpperCase()
  const phaseNum = Number(pipelineState?.phase_num || 0)

  const isIdle = !taRunStats.running && !taRunStats.decision
  const isComplete = !taRunStats.running && !!taRunStats.decision

  // Report dots
  const reportDots = useMemo(() => {
    return TRADING_AGENT_REPORT_CARD_DEFS.map((reportDef) => ({
      key: reportDef.agentId,
      short: reportDef.shortLabel,
      full: reportDef.label,
      icon: REPORT_DOT_META[reportDef.agentId]?.icon || '•',
      done: !!taRunStats.reportSections?.[reportDef.agentId],
    }))
  }, [taRunStats.reportSections])

  const displayedAgentsCompleted = Math.max(
    taRunStats.agentsCompleted || 0,
    Object.keys(taRunStats.completedAgents || {}).length,
  )

  return (
    <div className="ta-status-bar">
      {/* Top Row: Stats */}
      <div className="ta-status-bar__stats">
        {displayTicker && (
          <span className="ta-stat ta-stat--ticker">
            ${displayTicker}
          </span>
        )}

        <span className="ta-stat">
          <span className="ta-stat__label">Agents:</span>
          <span className="ta-stat__value">{displayedAgentsCompleted}/{taRunStats.agentsTotal}</span>
        </span>

        <span className="ta-stat-divider">│</span>

        <span className="ta-stat">
          <span className="ta-stat__label">LLM:</span>
          <span className="ta-stat__value">{taRunStats.llmCalls}</span>
        </span>

        <span className="ta-stat-divider">│</span>

        <span className="ta-stat">
          <span className="ta-stat__label">Tools:</span>
          <span className="ta-stat__value">{taRunStats.toolCalls}</span>
        </span>

        <span className="ta-stat-divider">│</span>

        <span className="ta-stat">
          <span className="ta-stat__label">Tokens:</span>
          <span className="ta-stat__value">{formatTokens(resolvedTokensUp, resolvedTokensDown)}</span>
        </span>

        <span className="ta-stat-divider">│</span>

        <span className="ta-stat">
          <span className="ta-stat__label">Reports:</span>
          <span className={`ta-stat__value ${taRunStats.reportSectionsCompleted === taRunStats.reportSectionsTotal ? 'ta-stat__value--complete' : ''}`}>
            {Math.max(taRunStats.reportSectionsCompleted || 0, reportDots.filter(r => r.done).length)}/{taRunStats.reportSectionsTotal || reportDots.length}
          </span>
        </span>

        <span className="ta-stat-divider">│</span>

        <span className="ta-stat ta-stat--timer">
          <span className="ta-stat__label">⏱</span>
          <span className="ta-stat__value">{formatTime(elapsed)}</span>
        </span>

        {taRunStats.decision && (
          <>
            <span className="ta-stat-divider">│</span>
            <span className={`ta-stat ta-stat--decision ta-stat--decision-${taRunStats.decision.toLowerCase()}`}>
              {taRunStats.decision}
            </span>
          </>
        )}
      </div>

      {/* Bottom Row: Report Dots */}
      {!compact && (
        <div className="ta-status-bar__reports">
          {reportDots.map(r => (
            <span
              key={r.key}
              className={`ta-report-dot ${r.done ? 'ta-report-dot--done' : ''}`}
              title={r.full}
            >
              <span className="ta-report-dot__icon">{r.icon}</span>
              <span className="ta-report-dot__label">{r.short}</span>
            </span>
          ))}
        </div>
      )}

      {/* Running indicator */}
      {taRunStats.running && (
        <div className="ta-status-bar__pulse" />
      )}
    </div>
  )
}
