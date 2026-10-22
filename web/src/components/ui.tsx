import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { avatarGradient, fmtDuration } from "../lib/format";
import { Status, hasPendingChange, type MemberView } from "../lib/data";
import { explainError } from "../lib/tx";

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="orb a" />
      <div className="orb b" />
      <div className="orb c" />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`glass modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Menu({
  trigger,
  children,
  align = "right",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`menu ${align === "left" ? "left" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Avatar({ address, size }: { address: string; size?: "lg" }) {
  return <div className={`avatar ${size ?? ""}`} style={{ background: avatarGradient(address) }} />;
}

export function StatusBadge({ m }: { m: MemberView }) {
  const employed = m.status === Status.Active || m.status === Status.Paused;
  let cls = "";
  let label = "—";
  if (employed && hasPendingChange(m)) [cls, label] = ["paused", "Wallet change"];
  else if (employed && !m.confirmed) [cls, label] = ["paused", "Unconfirmed"];
  else if (m.status === Status.Active) [cls, label] = m.salary === 0n ? ["", "Bonus-only"] : ["active", "Active"];
  else if (m.status === Status.Paused) [cls, label] = ["paused", "Paused"];
  else if (m.status === Status.Terminated) label = "Ended";
  return (
    <span className={`status ${cls}`}>
      <i />
      {label}
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn btn-ghost btn-sm ${label ? "" : "btn-icon"}`}
      aria-label="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label}
    </button>
  );
}

/** Seconds counting down from a chain snapshot taken at `since` (local ms), e.g. time to payday. */
export function Countdown({ seconds, since, precise }: { seconds: number; since: number; precise?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Number.isFinite(seconds) ? seconds - (now - since) / 1000 : Infinity;
  return <span className="num">{fmtDuration(left, precise)}</span>;
}

export function Skeleton({ width = "60%", height }: { width?: string | number; height?: number }) {
  return <div className="skeleton" style={{ width, height }} />;
}

export function ReadError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="banner" role="alert">
      <span style={{ flex: 1 }}>Couldn’t load payroll data. {explainError(error)}</span>
      {retry && <button className="btn btn-sm" onClick={retry}>Retry</button>}
    </div>
  );
}
