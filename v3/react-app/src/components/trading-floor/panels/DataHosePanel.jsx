import PropTypes from 'prop-types';
import { ActivityLog } from './ActivityLog';

export function DataHosePanel({ logs = [] }) {
    return (
        <div className="data-hose-panel" style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            background: 'transparent', // Inherit JRPG Blue Gradient
            fontFamily: '"Press Start 2P", cursive',
        }}>
            {/* Header */}
            <div style={{ padding: '16px', borderBottom: '4px solid var(--border-primary)', background: 'var(--bg-tertiary)' }}>
                <h3 style={{ margin: 0, color: 'var(--text-accent)', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px', textShadow: '2px 2px 0px rgba(0,0,0,0.5)' }}>
                    [ TERMINAL LOGS ]
                </h3>
            </div>

            {/* Activity Log Content */}
            <div className="tf-activity-section" style={{
                flex: 1,
                padding: '16px',
                overflow: 'hidden',
                color: 'var(--text-primary)',
                fontSize: '9px',
                lineHeight: '1.4'
            }}>
                <ActivityLog logs={logs} />
            </div>
        </div>
    );
}

DataHosePanel.propTypes = {
    logs: PropTypes.array
};
