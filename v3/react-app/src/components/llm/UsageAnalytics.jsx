const BAR_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#d97706', '#0891b2', '#10b981',
  '#6366f1', '#dc2626', '#0d9488', '#64748b', '#92400e',
]

function SimpleBar({ label, value, maxValue, color, suffix = '' }) {
  const pct = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0
  return (
    <div className="llm-bar">
      <div className="llm-bar__label">{label}</div>
      <div className="llm-bar__track">
        <div className="llm-bar__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="llm-bar__value">{value}{suffix}</div>
    </div>
  )
}

export default function UsageAnalytics({ usage, onReset }) {
  const providerStats = usage?.provider_stats || {}
  const phaseStats = usage?.phase_stats || {}
  const agentStats = usage?.agent_stats || {}

  // Provider call distribution
  const providerEntries = Object.entries(providerStats)
    .map(([name, s]) => ({ name, calls: s.requests_count || 0, errors: s.errors || 0, avg_ms: s.avg_response_time || 0 }))
    .filter(p => p.calls > 0)
    .sort((a, b) => b.calls - a.calls)

  const maxProviderCalls = Math.max(...providerEntries.map(p => p.calls), 1)

  // Phase call distribution
  const phaseEntries = Object.entries(phaseStats)
    .map(([name, s]) => ({ name, calls: s.total_calls || 0, avg_ms: s.avg_response_time_ms || 0 }))
    .filter(p => p.calls > 0)
    .sort((a, b) => b.calls - a.calls)

  const maxPhaseCalls = Math.max(...phaseEntries.map(p => p.calls), 1)

  return (
    <div className="llm-section">
      <div className="llm-section__header">
        <h2 className="llm-section__title">Usage Analytics</h2>
        <button className="llm-btn llm-btn--sm llm-btn--ghost" onClick={onReset}>
          Reset Stats
        </button>
      </div>

      <div className="llm-analytics-grid">
        {/* Provider Distribution */}
        <div className="llm-analytics-panel">
          <h3 className="llm-analytics-panel__title">Calls by Provider</h3>
          {providerEntries.length === 0 && <p className="panel-empty">No data yet</p>}
          {providerEntries.map((p, i) => (
            <SimpleBar
              key={p.name}
              label={p.name}
              value={p.calls}
              maxValue={maxProviderCalls}
              color={BAR_COLORS[i % BAR_COLORS.length]}
            />
          ))}
        </div>

        {/* Phase Distribution */}
        <div className="llm-analytics-panel">
          <h3 className="llm-analytics-panel__title">Calls by Phase</h3>
          {phaseEntries.length === 0 && <p className="panel-empty">No data yet</p>}
          {phaseEntries.map((p, i) => (
            <SimpleBar
              key={p.name}
              label={p.name}
              value={p.calls}
              maxValue={maxPhaseCalls}
              color={BAR_COLORS[i % BAR_COLORS.length]}
            />
          ))}
        </div>

        {/* Response Time by Provider */}
        <div className="llm-analytics-panel">
          <h3 className="llm-analytics-panel__title">Avg Response Time</h3>
          {providerEntries.length === 0 && <p className="panel-empty">No data yet</p>}
          {providerEntries
            .filter(p => p.avg_ms > 0)
            .sort((a, b) => a.avg_ms - b.avg_ms)
            .map((p, i) => (
              <SimpleBar
                key={p.name}
                label={p.name}
                value={Math.round(p.avg_ms)}
                maxValue={Math.max(...providerEntries.map(x => x.avg_ms), 1)}
                color={BAR_COLORS[i % BAR_COLORS.length]}
                suffix="ms"
              />
            ))
          }
        </div>

        {/* Error Rate */}
        <div className="llm-analytics-panel">
          <h3 className="llm-analytics-panel__title">Error Rate by Provider</h3>
          {providerEntries.filter(p => p.errors > 0).length === 0 && <p className="panel-empty">No errors</p>}
          {providerEntries
            .filter(p => p.errors > 0)
            .sort((a, b) => b.errors - a.errors)
            .map((p, i) => {
              const rate = p.calls > 0 ? Math.round((p.errors / p.calls) * 100) : 0
              return (
                <SimpleBar
                  key={p.name}
                  label={p.name}
                  value={rate}
                  maxValue={100}
                  color="#ef4444"
                  suffix="%"
                />
              )
            })
          }
        </div>
      </div>
    </div>
  )
}
