// ShowrunnerPanel.jsx - Scene Director controls
import { DevToolsPanel } from '../trading-floor/DevToolsPanel'

export function ShowrunnerPanel({ connected, onReconnect }) {
  return <DevToolsPanel connected={connected} onReconnect={onReconnect} />
}

export default ShowrunnerPanel
