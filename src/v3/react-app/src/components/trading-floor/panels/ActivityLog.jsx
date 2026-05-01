// Activity Log Component
import PropTypes from 'prop-types'

function LogEntry({ log }) {
  const isNews = log.type?.toUpperCase() === 'NEWS';
  const isGossip = log.type?.toUpperCase() === 'GOSSIP';
  const baseShadow = '2px 2px 0px rgba(26, 22, 37, 0.4)';

  const getStyle = () => {
    if (isNews) return { color: '#f59e0b', fontWeight: 'bold', borderLeft: '4px solid #f59e0b', paddingLeft: '12px', marginBottom: '8px', textShadow: baseShadow };
    if (isGossip) return { color: 'var(--text-accent)', fontStyle: 'italic', opacity: 1, textShadow: baseShadow };
    return { color: 'var(--text-primary)', textShadow: baseShadow };
  };

  return (
    <div className={`log-entry log-${log.type?.toLowerCase()}`} style={{
      ...getStyle(),
      padding: '8px 0',
      fontSize: '11px',
      lineHeight: '1.4',
      borderBottom: '1px solid var(--bg-tertiary)',
      display: 'flex',
      alignItems: 'center'
    }}>
      <span className="log-type" style={{ 
        minWidth: '70px', 
        opacity: 0.9, 
        fontWeight: '900',
        letterSpacing: '1px',
        fontSize: '9px',
        textTransform: 'uppercase'
      }}>[{log.type}]</span>
      <span className="log-msg" style={{ 
        textShadow: '1px 1px 0px rgba(26, 22, 37, 0.2)',
        flex: 1
      }}>{log.message}</span>
    </div>
  )
}

LogEntry.propTypes = {
  log: PropTypes.shape({
    type: PropTypes.string.isRequired,
    message: PropTypes.string.isRequired,
    timestamp: PropTypes.string
  }).isRequired
}

export function ActivityLog({ logs = [] }) {
  return (
    <div className="panel-section log-panel">
      <h3>📜 Activity</h3>
      <div className="log-list">
        {logs.map((log, i) => (
          <LogEntry key={i} log={log} />
        ))}
      </div>
    </div>
  )
}

ActivityLog.propTypes = {
  logs: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.string.isRequired,
      message: PropTypes.string.isRequired,
      timestamp: PropTypes.string
    })
  )
}
