// Analytics Panel - Provider stats, agent accuracy, LLM metrics
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { fetchProviderStats, fetchAnalyticsCycles, fetchAnalyticsProviders, fetchAnalyticsAgents } from '../../../services/api'

export function AnalyticsPanel({ pipelineHistory = [] }) {
  const [tab, setTab] = useState('providers')
  const [providerStats, setProviderStats] = useState({})
  const [analyticsCycles, setAnalyticsCycles] = useState([])
  const [analyticsAgents, setAnalyticsAgents] = useState({})
  const [analyticsProviders, setAnalyticsProviders] = useState({})

  // Poll analytics data
  useEffect(() => {
    const poll = async () => {
      try {
        const ps = await fetchProviderStats()
        if (ps) setProviderStats(ps)
      } catch { }
    }
    poll()
    const iv = setInterval(poll, 10000)
    return () => clearInterval(iv)
  }, [])

  // Poll DB analytics
  useEffect(() => {
    const pollAnalytics = async () => {
      try {
        const [cycles, providers, agents] = await Promise.allSettled([
          fetchAnalyticsCycles(),
          fetchAnalyticsProviders(),
          fetchAnalyticsAgents(),
        ])
        if (cycles.status === 'fulfilled' && Array.isArray(cycles.value)) setAnalyticsCycles(cycles.value)
        if (providers.status === 'fulfilled' && providers.value?.providers) setAnalyticsProviders(providers.value.providers)
        if (agents.status === 'fulfilled' && agents.value?.agents) setAnalyticsAgents(agents.value.agents)
      } catch { }
    }
    pollAnalytics()
    const iv = setInterval(pollAnalytics, 30000)
    return () => clearInterval(iv)
  }, [])

  return (
    <div className="tf-panel tf-panel--analytics">
      <div className="tf-panel__header">
        <h3>📈 Analytics</h3>
      </div>

      {/* Tab selector */}
      <div className="tf-analytics-tabs">
        {['providers', 'agents'].map(t => (
          <button
            key={t}
            className={`tf-tab-btn ${tab === t ? 'tf-tab-btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Providers tab */}
      {tab === 'providers' && (
        <div className="tf-analytics-content">
          {Object.keys(analyticsProviders).length === 0 && Object.keys(providerStats).length === 0 ? (
            <div className="tf-panel__empty">No provider data yet</div>
          ) : (
            <div className="tf-provider-list">
              {/* DB analytics providers */}
              {Object.values(analyticsProviders).map(p => {
                const errRate = p.calls > 0 ? ((p.errors || 0) / p.calls * 100).toFixed(1) : '0.0'
                const successRate = p.calls > 0 ? ((p.successes || 0) / p.calls * 100).toFixed(1) : '100.0'
                const barWidth = Math.min(100, Math.max(2, (p.successes || 0) / (p.calls || 1) * 100))

                return (
                  <div key={p.provider} className="tf-provider-card">
                    <div className="tf-provider-card__header">
                      <span className="tf-provider-card__name">{p.provider}</span>
                      <span
                        className="tf-provider-card__rate"
                        style={{ color: parseFloat(errRate) < 5 ? '#10b981' : '#ef4444' }}
                      >
                        {errRate}% err
                      </span>
                    </div>
                    <div className="tf-provider-card__bar">
                      <div
                        className="tf-provider-card__bar-fill"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                    <div className="tf-provider-card__stats">
                      <div className="tf-stat">
                        <span className="tf-stat__label">Calls</span>
                        <span className="tf-stat__value">{p.calls || 0}</span>
                      </div>
                      <div className="tf-stat">
                        <span className="tf-stat__label">Tokens</span>
                        <span className="tf-stat__value">{((p.tokens || 0) / 1000).toFixed(1)}k</span>
                      </div>
                      <div className="tf-stat">
                        <span className="tf-stat__label">Avg ms</span>
                        <span className="tf-stat__value">{Math.round(p.avg_ms || 0)}</span>
                      </div>
                      <div className="tf-stat">
                        <span className="tf-stat__label">Success</span>
                        <span className="tf-stat__value tf-stat__value--green">{successRate}%</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Agents tab */}
      {tab === 'agents' && (
        <div className="tf-analytics-content">
          {Object.keys(analyticsAgents).length === 0 ? (
            <div className="tf-panel__empty">No agent analytics yet</div>
          ) : (
            <div className="tf-agent-analytics-list">
              {Object.values(analyticsAgents).map(ag => {
                const total = ag.total_decisions || 1

                return (
                  <div key={ag.agent} className="tf-agent-analytics-card">
                    <div className="tf-agent-analytics-card__header">
                      <span className="tf-agent-analytics-card__name">{ag.agent}</span>
                      <div className="tf-agent-analytics-card__meta">
                        <span>{ag.total_decisions} decisions</span>
                        <span>{ag.llm_calls} calls</span>
                        <span>{((ag.llm_tokens || 0) / 1000).toFixed(1)}k tok</span>
                      </div>
                    </div>
                    {/* Decision distribution bar */}
                    <div className="tf-decision-dist-bar">
                      <div
                        className="tf-decision-dist-bar__buy"
                        style={{ width: `${ag.buy_pct}%` }}
                      />
                      <div
                        className="tf-decision-dist-bar__sell"
                        style={{ width: `${ag.sell_pct}%` }}
                      />
                      <div
                        className="tf-decision-dist-bar__hold"
                        style={{ width: `${ag.hold_pct}%` }}
                      />
                    </div>
                    <div className="tf-agent-analytics-card__footer">
                      <span style={{ color: 'var(--text-primary)' }}>▲ {ag.buy_pct}% ({ag.buys})</span>
                      <span style={{ color: 'var(--text-secondary)' }}>▼ {ag.sell_pct}% ({ag.sells})</span>
                      <span style={{ color: 'var(--text-secondary)' }}>— {ag.hold_pct}% ({ag.holds})</span>
                      <span style={{ marginLeft: 'auto' }}>conf: {((ag.avg_confidence || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Event count */}
      <div className="tf-analytics-footer">
        <span className="tf-muted">WS Events: {pipelineHistory?.length || 0}</span>
      </div>
    </div>
  )
}

AnalyticsPanel.propTypes = {
  pipelineHistory: PropTypes.array,
}

export default AnalyticsPanel
