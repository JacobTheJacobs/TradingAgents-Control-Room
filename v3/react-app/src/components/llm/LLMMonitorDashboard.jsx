/**
 * LLMMonitorDashboard
 *
 * Comprehensive LLM monitoring view:
 *   1. Provider Health Cards — status, calls, tokens, error rate per provider
 *   2. Hourly Trend Chart   — calls/hr + avg latency over last 24h (bar-based)
 *   3. Route Breakdown      — phase table + agent table side-by-side
 *   4. Legacy Analytics     — SimpleBar panels from original UsageAnalytics
 */

const STATUS_COLOR = {
  active:    '#22c55e',
  throttled: '#f59e0b',
  error:     '#ef4444',
}

const BAR_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#d97706', '#0891b2', '#10b981',
  '#6366f1', '#dc2626', '#0d9488', '#64748b', '#92400e',
]

// ─── tiny helpers ────────────────────────────────────────────────────────────

function fmt(n, decimals = 0) {
  if (n == null) return '—'
  return Number(n).toFixed(decimals)
}

function fmtK(n) {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// ─── SimpleBar (reused pattern from UsageAnalytics) ──────────────────────────

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

// ─── 1. Provider Health Cards ─────────────────────────────────────────────────

function ProviderHealthCards({ providerHealth }) {
  const providers = Object.values(providerHealth?.providers || {})
  if (providers.length === 0) {
    return <p className="panel-empty">No provider health data</p>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px', marginBottom: '16px' }}>
      {providers.map(p => {
        const statusColor = STATUS_COLOR[p.status] || '#64748b'
        const errPct = p.calls > 0 ? Math.min((p.errors / p.calls) * 100, 100) : 0
        return (
          <div key={p.name} style={{
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${statusColor}44`,
            borderRadius: '8px',
            padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '18px' }}>{p.emoji}</span>
              <span style={{
                fontSize: '10px',
                fontWeight: 600,
                color: statusColor,
                background: `${statusColor}22`,
                padding: '2px 6px',
                borderRadius: '4px',
                textTransform: 'uppercase',
              }}>{p.status}</span>
            </div>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', textTransform: 'capitalize' }}>{p.name}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
              {fmtK(p.calls)} calls · {fmtK(p.tokens)} tokens
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
              Err: {p.error_rate}% · Limit: {p.rpm_limit} RPM
            </div>
            {/* error rate bar */}
            <div style={{ height: '3px', background: '#1e293b', borderRadius: '2px' }}>
              <div style={{ height: '100%', width: `${errPct}%`, background: errPct > 20 ? '#ef4444' : '#22c55e', borderRadius: '2px' }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 2. Hourly Trend (bar-based, no external dep) ────────────────────────────

function HourlyTrendChart({ trend }) {
  if (!trend || trend.length === 0) {
    return <p className="panel-empty">No trend data (calls appear after the pipeline runs)</p>
  }

  const maxCalls = Math.max(...trend.map(r => r.calls), 1)
  const maxMs    = Math.max(...trend.map(r => r.avg_ms || 0), 1)

  return (
    <div>
      <div style={{ display: 'flex', gap: '16px', marginBottom: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#3b82f6', borderRadius: '2px' }} />
          Calls/hr
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#f59e0b', borderRadius: '2px' }} />
          Avg ms
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '80px', overflowX: 'auto' }}>
        {trend.map((r, i) => {
          const callH  = maxCalls > 0 ? (r.calls / maxCalls) * 76 : 0
          const msH    = maxMs > 0 ? ((r.avg_ms || 0) / maxMs) * 76 : 0
          const label  = r.hour ? r.hour.slice(11, 16) : `h${i}`
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '28px' }} title={`${r.hour} — ${r.calls} calls, ${fmt(r.avg_ms, 0)}ms avg`}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '76px' }}>
                <div style={{ width: '8px', height: `${callH}px`, background: '#3b82f6', borderRadius: '2px 2px 0 0', minHeight: '2px' }} />
                <div style={{ width: '8px', height: `${msH}px`, background: '#f59e0b', borderRadius: '2px 2px 0 0', minHeight: '2px' }} />
              </div>
              <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>{label}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 3. Route / Phase + Agent Breakdown Tables ───────────────────────────────

function BreakdownTable({ title, rows, nameKey }) {
  if (!rows || rows.length === 0) {
    return (
      <div>
        <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</h4>
        <p className="panel-empty">No data yet</p>
      </div>
    )
  }

  return (
    <div>
      <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 500 }}>Name</th>
            <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 500 }}>Calls</th>
            <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 500 }}>Tokens</th>
            <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 500 }}>Avg ms</th>
            <th style={{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 500 }}>Err</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const errColor = r.errors > 0 ? '#ef4444' : '#22c55e'
            return (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '5px 6px', fontWeight: 500, textTransform: 'capitalize' }}>{r[nameKey]}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', color: '#cbd5e1' }}>{fmtK(r.calls)}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtK(r.tokens)}</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmt(r.avg_ms, 0)}ms</td>
                <td style={{ padding: '5px 6px', textAlign: 'right', color: errColor, fontWeight: r.errors > 0 ? 600 : 400 }}>{r.errors}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── 4. Legacy SimpleBar panels (pass-through from original UsageAnalytics) ──

function LegacyAnalytics({ usage }) {
  const providerStats = usage?.provider_stats || {}
  const phaseStats    = usage?.phase_stats    || {}

  const providerEntries = Object.entries(providerStats)
    .map(([name, s]) => ({ name, calls: s.requests_count || 0, errors: s.errors || 0, avg_ms: s.avg_response_time || 0 }))
    .filter(p => p.calls > 0)
    .sort((a, b) => b.calls - a.calls)

  const maxProviderCalls = Math.max(...providerEntries.map(p => p.calls), 1)

  const phaseEntries = Object.entries(phaseStats)
    .map(([name, s]) => ({ name, calls: s.total_calls || 0, avg_ms: s.avg_response_time_ms || 0 }))
    .filter(p => p.calls > 0)
    .sort((a, b) => b.calls - a.calls)

  const maxPhaseCalls = Math.max(...phaseEntries.map(p => p.calls), 1)

  if (providerEntries.length === 0 && phaseEntries.length === 0) return null

  return (
    <div className="llm-analytics-grid" style={{ marginTop: '16px' }}>
      <div className="llm-analytics-panel">
        <h3 className="llm-analytics-panel__title">Calls by Provider (live)</h3>
        {providerEntries.length === 0
          ? <p className="panel-empty">No data yet</p>
          : providerEntries.map((p, i) => (
            <SimpleBar key={p.name} label={p.name} value={p.calls} maxValue={maxProviderCalls} color={BAR_COLORS[i % BAR_COLORS.length]} />
          ))}
      </div>

      <div className="llm-analytics-panel">
        <h3 className="llm-analytics-panel__title">Calls by Phase (live)</h3>
        {phaseEntries.length === 0
          ? <p className="panel-empty">No data yet</p>
          : phaseEntries.map((p, i) => (
            <SimpleBar key={p.name} label={p.name} value={p.calls} maxValue={maxPhaseCalls} color={BAR_COLORS[i % BAR_COLORS.length]} />
          ))}
      </div>

      <div className="llm-analytics-panel">
        <h3 className="llm-analytics-panel__title">Avg Response Time</h3>
        {providerEntries.filter(p => p.avg_ms > 0).length === 0
          ? <p className="panel-empty">No data yet</p>
          : providerEntries
              .filter(p => p.avg_ms > 0)
              .sort((a, b) => a.avg_ms - b.avg_ms)
              .map((p, i) => (
                <SimpleBar key={p.name} label={p.name} value={Math.round(p.avg_ms)} maxValue={Math.max(...providerEntries.map(x => x.avg_ms), 1)} color={BAR_COLORS[i % BAR_COLORS.length]} suffix="ms" />
              ))
        }
      </div>

      <div className="llm-analytics-panel">
        <h3 className="llm-analytics-panel__title">Error Rate by Provider</h3>
        {providerEntries.filter(p => p.errors > 0).length === 0
          ? <p className="panel-empty">No errors</p>
          : providerEntries
              .filter(p => p.errors > 0)
              .sort((a, b) => b.errors - a.errors)
              .map((p, i) => {
                const rate = p.calls > 0 ? Math.round((p.errors / p.calls) * 100) : 0
                return <SimpleBar key={p.name} label={p.name} value={rate} maxValue={100} color="#ef4444" suffix="%" />
              })
        }
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function LLMMonitorDashboard({ usage, routeAnalytics, providerHealth, onReset }) {
  const trend        = routeAnalytics?.hourly_trend   || []
  const phaseBreak   = routeAnalytics?.phase_breakdown || []
  const agentBreak   = routeAnalytics?.agent_breakdown || []

  // aggregate summary numbers
  const totalCalls  = phaseBreak.reduce((s, r) => s + (r.calls || 0), 0)
  const totalTokens = phaseBreak.reduce((s, r) => s + (r.tokens || 0), 0)
  const totalErrors = phaseBreak.reduce((s, r) => s + (r.errors || 0), 0)
  const avgMs       = phaseBreak.length > 0
    ? phaseBreak.reduce((s, r) => s + (r.avg_ms || 0), 0) / phaseBreak.length
    : 0

  return (
    <div className="llm-section">
      {/* Header */}
      <div className="llm-section__header">
        <h2 className="llm-section__title">LLM Monitor</h2>
        <button className="llm-btn llm-btn--sm llm-btn--ghost" onClick={onReset}>
          Reset Stats
        </button>
      </div>

      {/* Summary stat row */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total Calls',   value: fmtK(totalCalls) },
          { label: 'Total Tokens',  value: fmtK(totalTokens) },
          { label: 'Total Errors',  value: totalErrors, color: totalErrors > 0 ? '#ef4444' : '#22c55e' },
          { label: 'Avg Latency',   value: `${fmt(avgMs, 0)}ms` },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '8px 14px', minWidth: '90px' }}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: s.color || '#f1f5f9' }}>{s.value}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Section 1: Provider Health Cards */}
      <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Provider Health
      </h3>
      <ProviderHealthCards providerHealth={providerHealth} />

      {/* Section 2: Hourly Trend */}
      <div className="llm-analytics-panel" style={{ marginBottom: '16px' }}>
        <h3 className="llm-analytics-panel__title">Hourly Trend (last 24h)</h3>
        <HourlyTrendChart trend={trend} />
      </div>

      {/* Section 3: Route/Phase + Agent breakdown tables */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <div className="llm-analytics-panel">
          <BreakdownTable title="Pipeline Phase Breakdown" rows={phaseBreak} nameKey="phase" />
        </div>
        <div className="llm-analytics-panel">
          <BreakdownTable title="Agent Breakdown" rows={agentBreak} nameKey="agent_name" />
        </div>
      </div>

      {/* Section 4: Legacy live bar charts */}
      <LegacyAnalytics usage={usage} />
    </div>
  )
}
