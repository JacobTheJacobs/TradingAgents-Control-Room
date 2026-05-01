// Intern Panel Component - Free ticker analysis
import { useState, useCallback } from 'react'
import PropTypes from 'prop-types'

export function InternPanel({ onLog }) {
  const [internInput, setInternInput] = useState('')
  const [internResponse, setInternResponse] = useState(null)
  const [internLoading, setInternLoading] = useState(false)

  const askIntern = useCallback(async () => {
    const ticker = internInput.trim().toUpperCase().replace('$', '')
    if (!ticker) return

    setInternLoading(true)
    try {
      const response = await fetch(`/intern/analyze/${ticker}`)
      const data = await response.json()
      setInternResponse(data)
      onLog?.({ type: 'INTERN', message: `${ticker}: ${data.verdict?.split('|')[0].trim() || 'Analysis complete'}` })
    } catch (error) {
      setInternResponse({
        ticker,
        snarky_comment: 'The Intern is taking a coffee break. Try again later.',
        error: true
      })
    } finally {
      setInternLoading(false)
      setInternInput('')
    }
  }, [internInput, onLog])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      askIntern()
    }
  }

  return (
    <div className="panel-section intern-panel">
      <h3>🧑‍💻 Ask the Intern</h3>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        Free ticker analysis (RSI, MACD)
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={internInput}
          onChange={(e) => setInternInput(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          placeholder="$TICKER"
          disabled={internLoading}
          style={{
            flex: 1,
            background: 'var(--bg-primary)',
            border: '1px solid #FFD700',
            borderRadius: 4,
            padding: '6px 10px',
            color: 'var(--text-accent)',
            fontFamily: 'inherit',
            fontSize: 12,
            textTransform: 'uppercase'
          }}
        />
        <button
          onClick={askIntern}
          disabled={internLoading}
          style={{
            padding: '6px 12px',
            background: 'var(--text-accent)',
            color: '#000',
            border: 'none',
            borderRadius: 4,
            fontWeight: 'bold',
            cursor: internLoading ? 'wait' : 'pointer'
          }}
        >
          {internLoading ? '⏳' : '🔍'}
        </button>
      </div>
      {internResponse && (
        <div style={{ marginTop: 10, padding: 8, background: 'var(--bg-primary)', borderRadius: 4, fontSize: 11 }}>
          <div style={{ fontWeight: 'bold', color: 'var(--text-accent)' }}>
            {internResponse.ticker} {internResponse.price && `@ $${internResponse.price.toFixed(2)}`}
          </div>
          {internResponse.change_pct !== undefined && (
            <div style={{ color: internResponse.change_pct >= 0 ? '#10b981' : '#ef4444' }}>
              {internResponse.change_pct >= 0 ? '+' : ''}{internResponse.change_pct.toFixed(2)}% today
            </div>
          )}
          {internResponse.rsi !== undefined && (
            <div style={{ marginTop: 4, fontSize: 10 }}>
              RSI: <span style={{ color: internResponse.rsi >= 70 ? '#ef4444' : internResponse.rsi <= 30 ? '#10b981' : 'var(--text-muted)' }}>
                {internResponse.rsi.toFixed(0)}
              </span>
              {' | '}MACD: <span style={{ color: internResponse.macd_signal === 'BULLISH' ? '#10b981' : internResponse.macd_signal === 'BEARISH' ? '#ef4444' : 'var(--text-muted)' }}>
                {internResponse.macd_signal}
              </span>
            </div>
          )}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,215,0,0.3)', color: internResponse.error ? '#ef4444' : 'var(--text-primary)' }}>
            {internResponse.snarky_comment}
          </div>
        </div>
      )}
    </div>
  )
}

InternPanel.propTypes = {
  onLog: PropTypes.func
}

InternPanel.defaultProps = {
  onLog: null
}
