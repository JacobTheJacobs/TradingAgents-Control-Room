import PropTypes from 'prop-types'
import './BackendOfflineOverlay.css'

const STATUS_LABELS = {
  starting: 'STARTING',
  live: 'LIVE',
  offline: 'OFFLINE',
  recovering: 'RECOVERING',
}

export default function BackendOfflineOverlay({ backendHealth, onReconnect }) {
  const status = String(backendHealth?.status || 'offline').toLowerCase()
  const statusLabel = STATUS_LABELS[status] || 'OFFLINE'
  const currentMessage = backendHealth?.currentMessage || 'Backend unavailable.'
  const lastFailureReason = backendHealth?.lastFailureReason || null
  const activeHost = backendHealth?.activeHost || null

  return (
    <div className="backend-offline-overlay" role="alert" aria-live="assertive">
      <div className="backend-offline-overlay__panel">
        <div className="backend-offline-overlay__eyebrow">Trading Floor Control Link</div>
        <h2 className="backend-offline-overlay__title">
          {status === 'recovering' ? 'Reconnecting To Backend' : 'Backend Offline'}
        </h2>
        <p className="backend-offline-overlay__message">{currentMessage}</p>
        {lastFailureReason ? (
          <p className="backend-offline-overlay__detail">
            Last failure: <span>{lastFailureReason}</span>
          </p>
        ) : null}
        {activeHost ? (
          <p className="backend-offline-overlay__detail">
            Active target: <span>{activeHost}</span>
          </p>
        ) : null}
        <div className="backend-offline-overlay__footer">
          <span className={`backend-offline-overlay__status backend-offline-overlay__status--${status}`}>
            {statusLabel}
          </span>
          <button type="button" className="backend-offline-overlay__button" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      </div>
    </div>
  )
}

BackendOfflineOverlay.propTypes = {
  backendHealth: PropTypes.shape({
    status: PropTypes.string,
    activeHost: PropTypes.string,
    currentMessage: PropTypes.string,
    lastFailureReason: PropTypes.string,
  }),
  onReconnect: PropTypes.func.isRequired,
}
