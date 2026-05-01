// Agent Status Panel - Live agent decisions and confidence
import PropTypes from 'prop-types'

const DECISION_COLORS = {
  BUY: '#10b981', STRONG_BUY: '#10b981',
  SELL: '#ef4444', STRONG_SELL: '#dc2626',
  HOLD: '#f59e0b', AVOID: 'var(--text-secondary)',
}

function fmtConf(c) {
  if (typeof c !== 'number') return '---'
  return c > 1 ? `${c}%` : `${Math.round(c * 100)}%`
}

export function AgentStatusPanel({ 
  agentStates = {}, 
  currentTicker = null, 
  pipelinePhase = 'idle',
  agents: dynamicAgents = {} 
}) {
  // Use dynamic agents from prop, or fallback to object keys of agentStates if prop is missing
  const agentNames = Object.keys(dynamicAgents).length > 0 
    ? Object.keys(dynamicAgents)
    : Object.keys(agentStates || {})

  const agents = agentNames.map(name => ({
    name,
    archetype: dynamicAgents[name]?.personality || 'AI Agent',
    color: dynamicAgents[name]?.color || 'var(--text-primary)',
    state: agentStates?.[name] || null,
  }))

  const researching = agents.filter(a => a.state?.status === 'researching')
  const decided = agents.filter(a => a.state?.status === 'decided')
  const totalAgents = agents.length || 1

  const decisionCounts = agents.reduce((acc, a) => {
    const d = a.state?.decision || 'HOLD'
    acc[d] = (acc[d] || 0) + 1
    return acc
  }, {})

  return (
    <div className="tf-panel tf-panel--agents">
      <div className="tf-panel__header">
        <h3>🤖 Agents</h3>
        {currentTicker && (
          <span className="tf-panel__badge">
            {currentTicker}
          </span>
        )}
      </div>

      {/* Status counts */}
      <div className="tf-agent-counts">
        <div className="tf-agent-count">
          <span className="tf-agent-count__dot tf-agent-count__dot--researching"></span>
          <span>{researching.length} researching</span>
        </div>
        <div className="tf-agent-count">
          <span className="tf-agent-count__dot tf-agent-count__dot--decided"></span>
          <span>{decided.length} decided</span>
        </div>
      </div>

      {/* Decision summary bar */}
      <div className="tf-decision-bar">
        {Object.entries(decisionCounts).map(([decision, count]) => (
          <div
            key={decision}
            className="tf-decision-segment"
            style={{
              width: `${(count / totalAgents) * 100}%`,
              background: DECISION_COLORS[decision] || 'var(--text-secondary)',
            }}
            title={`${decision}: ${count}`}
          />
        ))}
      </div>

      {/* Agent grid */}
      <div className="tf-agent-grid">
        {agents.map(agent => {
          const s = agent.state
          const decision = s?.decision || 'HOLD'
          const conf = s?.confidence
          const decColor = DECISION_COLORS[decision] || 'var(--text-secondary)'
          const statusDot = s?.status === 'researching' ? '#f59e0b' 
            : s?.status === 'decided' ? '#10b981' 
            : '#475569'

          return (
            <div key={agent.name} className="tf-agent-card" style={{ borderColor: decColor + '40' }}>
              <div className="tf-agent-card__header">
                <span className="tf-agent-card__name" style={{ color: agent.color }}>
                  {agent.name}
                </span>
                <div className="tf-agent-card__status">
                  <span 
                    className="tf-agent-card__dot" 
                    style={{ background: statusDot }}
                  />
                  {s && (
                    <span 
                      className="tf-agent-card__decision"
                      style={{ 
                        background: decColor + '20', 
                        color: decColor,
                        borderColor: decColor + '40'
                      }}
                    >
                      {decision}
                    </span>
                  )}
                </div>
              </div>
              {s ? (
                <div className="tf-agent-card__info">
                  <span className="tf-agent-card__conf">
                    Conf: <strong style={{ color: decColor }}>{fmtConf(conf)}</strong>
                  </span>
                </div>
              ) : (
                <div className="tf-agent-card__info tf-agent-card__info--muted">
                  {agent.archetype}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

AgentStatusPanel.propTypes = {
  agentStates: PropTypes.object,
  currentTicker: PropTypes.string,
  pipelinePhase: PropTypes.string,
  agents: PropTypes.object,
}

export default AgentStatusPanel
