import { addressUrl, FAUCET_URL } from "../lib/chain";
import { ArrowUpRight, Droplets, ExternalLink, LogOut, Wallet } from "lucide-react";
import { fmt, shortAddr } from "../lib/format";
import { useWallet } from "../lib/wallet";
import { PROJECT_NAME } from "../lib/brand";
import { Avatar, CopyButton, Menu } from "./ui";

export type View = "employer" | "employee";

export function BrandMark() {
  return (
    <div className="brand" role="img" aria-label={PROJECT_NAME}>
      <div className="brand-mark">
        <svg width="16" height="16" viewBox="0 0 64 64" aria-hidden>
          <defs>
            <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a9c4ff" />
              <stop offset="1" stopColor="#c4b5fd" />
            </linearGradient>
          </defs>
          <path d="M10 50 L28 14 L52 50" fill="none" stroke="url(#bm)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="52" cy="16" r="7" fill="url(#bm)" />
        </svg>
      </div>
      <span className="brand-name">{PROJECT_NAME}</span>
    </div>
  );
}

export function TopBar({ view, setView, balance }: { view: View; setView: (v: View) => void; balance?: bigint }) {
  const { account, wrongNetwork, connect, connecting, wallets, disconnect, ensureLitvm } = useWallet();

  return (
    <header className="topbar">
      <div className="container">
        <BrandMark />
        <div className="nav-center">
          {account && (
            <div className="seg" role="tablist">
              <button aria-pressed={view === "employer"} onClick={() => setView("employer")}>
                Employer
              </button>
              <button aria-pressed={view === "employee"} onClick={() => setView("employee")}>
                Employee
              </button>
            </div>
          )}
        </div>

        {account && wrongNetwork ? (
          <button className="pill warn" onClick={() => ensureLitvm().catch(() => {})}>
            <span className="led" /> Switch to LitVM
          </button>
        ) : (
          <span className="pill hide-sm">
            <span className="led" /> LiteForge
          </span>
        )}

        {account ? (
          <Menu
            trigger={(_, toggle) => (
              <button className="btn btn-sm" onClick={toggle}>
                <Avatar address={account} />
                <span className="hide-sm num">{balance !== undefined ? `${fmt(balance, 18, 3)} zkLTC` : "…"}</span>
                <span className="mono hide-sm">{shortAddr(account)}</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-label row">
                  <span className="mono">{shortAddr(account)}</span>
                  <span className="spacer" />
                  <CopyButton text={account} />
                </div>
                <a href={addressUrl(account)} target="_blank" rel="noreferrer" onClick={close}>
                  <ExternalLink size={15} /> View on explorer
                </a>
                <a href={FAUCET_URL} target="_blank" rel="noreferrer" onClick={close}>
                  <Droplets size={15} /> Get testnet zkLTC <ArrowUpRight size={13} className="faint" />
                </a>
                <div className="sep" />
                <button
                  className="danger"
                  onClick={() => {
                    close();
                    disconnect();
                  }}
                >
                  <LogOut size={15} /> Disconnect
                </button>
              </>
            )}
          </Menu>
        ) : wallets.length > 1 ? (
          <Menu
            trigger={(_, toggle) => (
              <button className="btn btn-primary btn-sm" onClick={toggle} disabled={connecting}>
                <Wallet size={15} /> Connect
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-label">Choose a wallet</div>
                {wallets.map((w) => (
                  <button
                    key={w.uuid}
                    onClick={() => {
                      close();
                      connect(w);
                    }}
                  >
                    <img src={w.icon} alt="" /> {w.name}
                  </button>
                ))}
              </>
            )}
          </Menu>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => connect()} disabled={connecting}>
            <Wallet size={15} /> {connecting ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}
