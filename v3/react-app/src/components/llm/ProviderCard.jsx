import { useState } from 'react'

const STATUS_COLORS = {
  active: '#22c55e',
  throttled: '#f59e0b',
  error: '#ef4444',
  no_key: '#64748b',
}

export default function ProviderCard({ provider, onTest, onToggle, onUpdate }) {
  const [expanded, setExpanded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const stats = provider.stats || {}
  const status = provider.loaded
    ? (stats.status || 'active')
    : 'no_key'
  const statusColor = STATUS_COLORS[status] || '#64748b'

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await onTest(provider.key)
      setTestResult(result)
    } catch (e) {
      setTestResult({ success: false, error: e.message })
    }
    setTesting(false)
  }

  return (
    <div className={`llm-provider-card ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)}>
      <div className="llm-provider-card__header">
        <div className="llm-provider-card__name">
          <span className="llm-provider-card__dot" style={{ background: statusColor }} />
          <span>{provider.name || provider.key}</span>
        </div>
        <div className="llm-provider-card__badge" style={{ color: statusColor }}>
          {status}
        </div>
      </div>

      <div className="llm-provider-card__stats">
        <div className="llm-provider-card__stat">
          <span className="llm-provider-card__stat-value">{stats.current_rpm || 0}</span>
          <span className="llm-provider-card__stat-label">RPM</span>
        </div>
        <div className="llm-provider-card__stat">
          <span className="llm-provider-card__stat-value">{stats.requests_count || 0}</span>
          <span className="llm-provider-card__stat-label">Calls</span>
        </div>
        <div className="llm-provider-card__stat">
          <span className="llm-provider-card__stat-value">{Math.round(stats.avg_response_time || 0)}ms</span>
          <span className="llm-provider-card__stat-label">Avg</span>
        </div>
        <div className="llm-provider-card__stat">
          <span className="llm-provider-card__stat-value" style={{ color: (stats.errors || 0) > 0 ? '#ef4444' : '#22c55e' }}>
            {stats.errors || 0}
          </span>
          <span className="llm-provider-card__stat-label">Errors</span>
        </div>
      </div>

      {expanded && (
        <div className="llm-provider-card__details" onClick={e => e.stopPropagation()}>
          <div className="llm-provider-card__models">
            <div className="llm-provider-card__detail-label">Models ({(provider.models || []).length})</div>
            <div className="llm-provider-card__model-list">
              {(provider.models || []).slice(0, 8).map((m, i) => (
                <span key={i} className="llm-provider-card__model-tag">
                  {typeof m === 'string' ? m : (m.name || m.id)}
                </span>
              ))}
              {(provider.models || []).length > 8 && (
                <span className="llm-provider-card__model-tag llm-provider-card__model-more">
                  +{(provider.models || []).length - 8} more
                </span>
              )}
            </div>
          </div>

          <div className="llm-provider-card__detail-row">
            <span className="llm-provider-card__detail-label">RPM Limit</span>
            <span>{provider.rpm_limit || stats.rpm_limit || '?'}</span>
          </div>

          <div className="llm-provider-card__actions">
            <button
              className="llm-btn llm-btn--sm llm-btn--test"
              onClick={handleTest}
              disabled={testing || !provider.loaded}
            >
              {testing ? 'Testing...' : 'Test'}
            </button>
          </div>

          {testResult && (
            <div className={`llm-provider-card__test-result ${testResult.success ? 'success' : 'fail'}`}>
              {testResult.success
                ? `OK: ${testResult.response_time_ms}ms - "${(testResult.response || '').slice(0, 60)}"`
                : `FAIL: ${testResult.error || 'Unknown error'}`
              }
            </div>
          )}
        </div>
      )}
    </div>
  )
}
