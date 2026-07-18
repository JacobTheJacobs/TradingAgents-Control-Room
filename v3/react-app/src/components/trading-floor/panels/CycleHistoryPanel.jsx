// Cycle History Panel - Table of past cycles with regime/trades
import { useMemo } from 'react'
import PropTypes from 'prop-types'

const REGIME_COLORS = {
  BULL_TREND: '#10b981',
  BEAR_TREND: '#ef4444',
  HIGH_VOLATILITY_CHOP: '#f59e0b',
  MACRO_TRANSITION: '#8b5cf6',
}

function fmtTime(ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleTimeString() } catch { return ts }
}

function fmtMoney(n) {
  if (typeof n !== 'number') return '$0'
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function CycleHistoryPanel({ pipelineHistory = [], cycle: currentCycle = 0 }) {
  // Derive per-cycle summaries from pipeline history
  const cycleSummaries = useMemo(() => {
    const map = {}
    for (const msg of pipelineHistory || []) {
      const c = msg.cycle
      if (!c) continue
      if (!map[c]) map[c] = {
        cycle: c,
        tickers: new Set(),
        regime: null,
        trades: [],
        agentCount: 0,
        agentDecisions: {},
        portfolioValue: null,
        startTime: msg.timestamp,
        endTime: msg.timestamp,
      }
      const entry = map[c]
      if (msg.timestamp > entry.endTime) entry.endTime = msg.timestamp
      if (msg.timestamp < entry.startTime) entry.startTime = msg.timestamp
      if (msg.type === 'pipeline_phase' && msg.regime) entry.regime = msg.regime
      if (msg.type === 'pipeline_phase' && msg.ticker) entry.tickers.add(msg.ticker)
      if (msg.type === 'trade_executed') entry.trades.push(msg)
      if (msg.type === 'portfolio_update' && msg.total_value) entry.portfolioValue = msg.total_value
      if ((msg.type === 'agent_decision' || msg.type === 'agent_action') && msg.agent) {
        entry.agentDecisions[msg.agent] = msg.decision || msg.action
        entry.agentCount = Object.keys(entry.agentDecisions).length
      }
    }
    return Object.values(map)
      .map(e => ({ ...e, tickers: Array.from(e.tickers) }))
      .sort((a, b) => b.cycle - a.cycle)
  }, [pipelineHistory])

  if (cycleSummaries.length === 0) {
    return (
      <div className="tf-panel tf-panel--cycles">
        <div className="tf-panel__header">
          <h3>📊 Cycle History</h3>
        </div>
        <div className="tf-panel__empty">
          No cycles recorded yet
        </div>
      </div>
    )
  }

  return (
    <div className="tf-panel tf-panel--cycles">
      <div className="tf-panel__header">
        <h3>📊 Cycle History</h3>
        <span className="tf-panel__count">{cycleSummaries.length} cycles</span>
      </div>

      <div className="tf-cycle-table-wrapper">
        <table className="tf-cycle-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Regime</th>
              <th>Tickers</th>
              <th>Trades</th>
              <th>Value</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {cycleSummaries.map(c => {
              const isCurrent = c.cycle === currentCycle
              const buys = c.trades.filter(t => t.action === 'BUY' || t.action === 'STRONG_BUY').length
              const sells = c.trades.filter(t => t.action === 'SELL' || t.action === 'STRONG_SELL').length
              const regimeColor = REGIME_COLORS[c.regime] || 'var(--text-secondary)'

              return (
                <tr key={c.cycle} className={isCurrent ? 'tf-cycle-row--live' : ''}>
                  <td>
                    <span className={`tf-cycle-badge ${isCurrent ? 'tf-cycle-badge--live' : ''}`}>
                      {c.cycle}
                    </span>
                    {isCurrent && <span className="tf-live-indicator">LIVE</span>}
                  </td>
                  <td>
                    {c.regime ? (
                      <span 
                        className="tf-regime-badge"
                        style={{ background: regimeColor + '18', color: regimeColor }}
                      >
                        {c.regime.replace(/_/g, ' ')}
                      </span>
                    ) : (
                      <span className="tf-muted">---</span>
                    )}
                  </td>
                  <td>
                    <div className="tf-ticker-list">
                      {c.tickers.length > 0 ? c.tickers.slice(0, 3).map(t => (
                        <span key={t} className="tf-ticker-tag">{t}</span>
                      )) : (
                        <span className="tf-muted">---</span>
                      )}
                      {c.tickers.length > 3 && (
                        <span className="tf-muted">+{c.tickers.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {c.trades.length === 0 ? (
                      <span className="tf-muted">None</span>
                    ) : (
                      <div className="tf-trade-summary">
                        {buys > 0 && (
                          <span className="tf-trade-badge tf-trade-badge--buy">↑{buys}</span>
                        )}
                        {sells > 0 && (
                          <span className="tf-trade-badge tf-trade-badge--sell">↓{sells}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {c.portfolioValue != null ? (
                      <span className="tf-value">{fmtMoney(c.portfolioValue)}</span>
                    ) : (
                      <span className="tf-muted">---</span>
                    )}
                  </td>
                  <td className="tf-time">{fmtTime(c.endTime)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="tf-cycle-legend">
        {Object.entries(REGIME_COLORS).map(([name, color]) => (
          <div key={name} className="tf-legend-item">
            <span className="tf-legend-dot" style={{ background: color }} />
            <span>{name.replace(/_/g, ' ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

CycleHistoryPanel.propTypes = {
  pipelineHistory: PropTypes.array,
  cycle: PropTypes.number,
}

export default CycleHistoryPanel
