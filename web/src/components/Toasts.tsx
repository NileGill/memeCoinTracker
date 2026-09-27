import { ALERT_ICONS } from '../lib/alerts';
import { dismissToast, openToken, useStore } from '../store';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((a) => (
        <div
          key={a.id}
          className={`toast ${a.severity}`}
          onClick={() => {
            if (a.mint) openToken(a.mint);
            else if (a.url) window.open(a.url, '_blank', 'noopener');
            dismissToast(a.id);
          }}
        >
          <span className={`alert-kind ${a.severity}`}>
            <Icon name={ALERT_ICONS[a.kind]} size={15} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title">{a.title}</div>
            <div className="t-body">{a.body}</div>
          </div>
          <button
            className="close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(a.id);
            }}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
