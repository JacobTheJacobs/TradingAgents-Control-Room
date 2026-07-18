import { useState } from 'react'

const PHASE_ICONS = {
  scout: 'S',
  pre_mortem: 'PM',
  war_room: 'WR',
  agents: 'AG',
  oracle: 'OR',
  predictions: 'PR',
}

const PHASE_LABELS = {
  scout: 'Scout',
  pre_mortem: 'Pre-Mortem',
  war_room: 'War Room',
  agents: 'Agents',
  oracle: 'Oracle',
  predictions: 'Predictions',
}

const PHASE_COLORS = {
  scout: '#D35400',
  pre_mortem: '#ef4444',
  war_room: '#8b5cf6',
  agents: '#3b82f6',
  oracle: '#f59e0b',
  predictions: '#22c55e',
}

export default function PhaseCard({ phaseName, config, providerOptions, onUpdate }) {
  const [editing, setEditing] = useState(false)
  const [provider, setProvider] = useState(config?.provider || 'auto')
  const [model, setModel] = useState(config?.model || '')
  const [maxCalls, setMaxCalls] = useState(config?.max_calls || 1)
  const [enabled, setEnabled] = useState(config?.enabled !== false)
  const [multiModel, setMultiModel] = useState(config?.multi_model || false)

  const stats = config?.stats || {}
  const color = PHASE_COLORS[phaseName] || '#3b82f6'

  const handleSave = () => {
    onUpdate(phaseName, {
      provider,
      model: model || null,
      max_calls: maxCalls,
      enabled,
      multi_model: multiModel,
    })
    setEditing(false)
  }

  // Get models for selected provider
  const selectedProviderData = providerOptions.find(p => p.key === provider)
  const modelOptions = selectedProviderData?.models || []

  return (
    <div className={`llm-phase-card ${!enabled ? 'disabled' : ''}`} style={{ borderColor: color }}>
      <div className="llm-phase-card__header">
        <div className="llm-phase-card__icon" style={{ background: color }}>
          {PHASE_ICONS[phaseName] || '?'}
        </div>
        <div className="llm-phase-card__title">
          <span>{PHASE_LABELS[phaseName] || phaseName}</span>
          <span className="llm-phase-card__provider-badge">
            {config?.provider === 'auto' ? 'Round-Robin' : config?.provider}
          </span>
        </div>
        <label className="llm-toggle" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => {
              setEnabled(e.target.checked)
              onUpdate(phaseName, { enabled: e.target.checked })
            }}
          />
          <span className="llm-toggle__slider" />
        </label>
      </div>

      <div className="llm-phase-card__stats">
        <div className="llm-phase-card__stat">
          <span className="llm-phase-card__stat-value">{stats.total_calls || 0}</span>
          <span className="llm-phase-card__stat-label">Calls</span>
        </div>
        <div className="llm-phase-card__stat">
          <span className="llm-phase-card__stat-value">{Math.round(stats.avg_response_time || 0)}ms</span>
          <span className="llm-phase-card__stat-label">Avg Time</span>
        </div>
        <div className="llm-phase-card__stat">
          <span className="llm-phase-card__stat-value">{config?.max_calls || 1}</span>
          <span className="llm-phase-card__stat-label">Max Calls</span>
        </div>
      </div>

      {!editing ? (
        <button className="llm-btn llm-btn--sm llm-btn--ghost" onClick={() => setEditing(true)}>
          Configure
        </button>
      ) : (
        <div className="llm-phase-card__edit" onClick={e => e.stopPropagation()}>
          <div className="llm-form-row">
            <label>Provider</label>
            <select value={provider} onChange={e => { setProvider(e.target.value); setModel('') }}>
              <option value="auto">Auto (Round-Robin)</option>
              {providerOptions.filter(p => p.loaded).map(p => (
                <option key={p.key} value={p.key}>{p.name || p.key}</option>
              ))}
            </select>
          </div>

          {provider !== 'auto' && modelOptions.length > 0 && (
            <div className="llm-form-row">
              <label>Model</label>
              <select value={model} onChange={e => setModel(e.target.value)}>
                <option value="">Default</option>
                {modelOptions.map((m, i) => (
                  <option key={i} value={typeof m === 'string' ? m : m.id}>
                    {typeof m === 'string' ? m : (m.name || m.id)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="llm-form-row">
            <label>Max Calls: {maxCalls}</label>
            <input
              type="range"
              min="1" max="20"
              value={maxCalls}
              onChange={e => setMaxCalls(parseInt(e.target.value))}
            />
          </div>

          <div className="llm-form-row">
            <label>
              <input
                type="checkbox"
                checked={multiModel}
                onChange={e => setMultiModel(e.target.checked)}
              />
              {' '}Multi-Model (parallel)
            </label>
          </div>

          <div className="llm-phase-card__edit-actions">
            <button className="llm-btn llm-btn--sm llm-btn--primary" onClick={handleSave}>Save</button>
            <button className="llm-btn llm-btn--sm llm-btn--ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
