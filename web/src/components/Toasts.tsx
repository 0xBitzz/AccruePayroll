import { CheckCircle2, ExternalLink, Info, Loader2, X, XCircle } from "lucide-react";
import { useTx } from "../lib/tx";
import { txUrl } from "../lib/chain";

export function Toasts() {
  const { toasts, dismiss } = useTx();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`glass toast ${t.kind}`}>
          <span className="t-icon">
            {t.kind === "pending" && <Loader2 size={18} className="spin" />}
            {t.kind === "success" && <CheckCircle2 size={18} />}
            {t.kind === "error" && <XCircle size={18} />}
            {t.kind === "info" && <Info size={18} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
            {t.hash && (
              <a href={txUrl(t.hash)} target="_blank" rel="noreferrer">
                View transaction <ExternalLink size={12} />
              </a>
            )}
            {t.link && (
              <a href={t.link.href} target="_blank" rel="noreferrer">
                {t.link.label} <ExternalLink size={12} />
              </a>
            )}
          </div>
          <button className="x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
