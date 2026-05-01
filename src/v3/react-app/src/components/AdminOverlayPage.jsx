import TradingFloorPage from './TradingFloorPage'
import { useTradingFloor } from '../context/TradingFloorContext'
import './AdminOverlayPage.css'

export default function AdminOverlayPage(props) {
  const isResizing = false;
  const { 
    state: { hideNews, hideCycle, hideLeftSidebar, hideRightSidebar, showPerformanceView }
  } = useTradingFloor();
  const autoScale = 1;

  return (
    <div className="admin-split-root" style={{ 
      display: 'flex', 
      width: '100vw', 
      height: '100vh', 
      overflow: 'hidden',
      background: '#0a0a0a',
      flexDirection: 'row'
    }}>
      {/* LEFT: Scalable Main UI */}
      <div className="admin-left-pane-ui" style={{ 
        flex: 1, 
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <div style={{ 
          width: '100vw', 
          height: '100vh',
          transform: `scale(${autoScale})`,
          transformOrigin: 'center center',
          transition: isResizing ? 'none' : 'transform 0.1s ease-out',
          flexShrink: 0
        }}>
          <TradingFloorPage 
            mode="obs" 
            hideNews={hideNews} 
            hideCycle={hideCycle} 
            hideLeftSidebar={hideLeftSidebar}
            hideRightSidebar={hideRightSidebar}
            showPerformanceView={showPerformanceView}
            {...props} 
          />
        </div>
      </div>

      {/* Far-right admin pane removed by request. */}
    </div>
  )
}

