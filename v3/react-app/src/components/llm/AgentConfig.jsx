import { useState } from 'react'
import AgentLLMCard from './AgentLLMCard'

const AGENT_ORDER = [
  'Warren', 'Charlie', 'Technical', 'Fundamental', 'Sentiment',
  'Risk', 'Momentum', 'Value', 'Growth', 'Contrarian',
  'Macro', 'Activist', 'Valuation',
]

export default function AgentConfig({ agents, providerOptions, onUpdateAgent }) {
  const [bulkProvider, setBulkProvider] = useState('auto')

  const handleBulkApply = () => {
    AGENT_ORDER.forEach(name => {
      onUpdateAgent(name, { provider: bulkProvider, model: null })
    })
  }

  return (
    <div className="llm-section">
      <div className="llm-section__header">
        <h2 className="llm-section__title">Agent LLM Config</h2>
        <div className="llm-section__bulk">
          <select value={bulkProvider} onChange={e => setBulkProvider(e.target.value)}>
            <option value="auto">Auto (Round-Robin)</option>
            {providerOptions.filter(p => p.loaded).map(p => (
              <option key={p.key} value={p.key}>{p.name || p.key}</option>
            ))}
          </select>
          <button className="llm-btn llm-btn--sm" onClick={handleBulkApply}>
            Apply to All
          </button>
        </div>
      </div>

      <div className="llm-agent-grid">
        {AGENT_ORDER.map(name => (
          <AgentLLMCard
            key={name}
            name={name}
            config={agents?.[name]}
            providerOptions={providerOptions}
            onUpdate={onUpdateAgent}
          />
        ))}
      </div>
    </div>
  )
}
