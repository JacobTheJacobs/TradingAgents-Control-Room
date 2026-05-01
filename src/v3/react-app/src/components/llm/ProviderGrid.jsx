import { useState } from 'react'
import ProviderCard from './ProviderCard'

export default function ProviderGrid({ providers, onTest, onTestAll }) {
  const [testingAll, setTestingAll] = useState(false)

  const providerList = Object.values(providers || {}).sort((a, b) => {
    // Loaded first, then alphabetical
    if (a.loaded && !b.loaded) return -1
    if (!a.loaded && b.loaded) return 1
    return (a.name || a.key || '').localeCompare(b.name || b.key || '')
  })

  const loadedCount = providerList.filter(p => p.loaded).length
  const totalCalls = providerList.reduce((sum, p) => sum + (p.stats?.requests_count || 0), 0)
  const totalErrors = providerList.reduce((sum, p) => sum + (p.stats?.errors || 0), 0)

  const handleTestAll = async () => {
    setTestingAll(true)
    if (onTestAll) await onTestAll()
    setTestingAll(false)
  }

  return (
    <div className="llm-section">
      <div className="llm-section__header">
        <h2 className="llm-section__title">Providers</h2>
        <div className="llm-section__summary">
          <span className="llm-tag llm-tag--green">{loadedCount} loaded</span>
          <span className="llm-tag">{totalCalls} calls</span>
          {totalErrors > 0 && <span className="llm-tag llm-tag--red">{totalErrors} errors</span>}
        </div>
        <button
          className="llm-btn llm-btn--sm"
          onClick={handleTestAll}
          disabled={testingAll}
        >
          {testingAll ? 'Testing...' : 'Test All'}
        </button>
      </div>
      <div className="llm-provider-grid">
        {providerList.map(p => (
          <ProviderCard
            key={p.key}
            provider={p}
            onTest={onTest}
          />
        ))}
      </div>
    </div>
  )
}
