// DevToolsPanel.jsx - connectivity status panel

import './DevToolsPanel.css'

export function DevToolsPanel({ connected = false, onReconnect }) {
  return (
    <div className="showrunner-panel">
      <div className={`showrunner-section devtools-connection ${connected ? 'is-connected' : 'is-disconnected'}`}>
        <div className="showrunner-connection-row">
          <div className="showrunner-connection-main">
            <div
              className={`devtools-connection-dot ${connected ? 'is-connected' : 'is-disconnected'}`}
            />
            <span className={`devtools-connection-label ${connected ? 'is-connected' : 'is-disconnected'}`}>
              {connected ? 'WS CONNECTED' : 'WS DISCONNECTED'}
            </span>
            {!connected && (
              <span className="devtools-connection-note">- Commands will not sync</span>
            )}
          </div>
          {!connected && onReconnect && (
            <button
              className="showrunner-btn showrunner-reconnect-btn"
              onClick={onReconnect}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default DevToolsPanel
