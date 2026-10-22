import { useEffect, useState } from "react";
import { ArrowRight, Banknote, CalendarClock, Gift, Lock, ShieldCheck, Split } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { addressUrl } from "../lib/chain";
import { PROJECT_NAME } from "../lib/brand";
import { PAYROLL, LUSD } from "../lib/data";
import { fmtDate, fmtDuration, monthName, shortAddr } from "../lib/format";
import { Avatar } from "./ui";

const FEATURES = [
  { icon: CalendarClock, title: "Fixed monthly payday", body: "Pick the 1st–28th. Everyone on payroll that day gets their full salary." },
  { icon: Banknote, title: "One-click payroll", body: "Pay the whole team in a single transaction, with a preview of every payout first." },
  { icon: Lock, title: "Salaries are reserved", body: "The next payroll always stays in the treasury. Employers can only withdraw the surplus." },
  { icon: ShieldCheck, title: "Verified payout wallets", body: "Employees confirm their wallet before the first payout. Wallet changes wait 48h and can be blocked." },
  { icon: Split, title: "Auto-split payouts", body: "Employees route a share of every salary to savings or a tax wallet, automatically." },
  { icon: Gift, title: "Instant bonuses", body: "Reward one person or the whole team in one transaction, with an on-chain memo." },
];

const DEMO_TEAM = [
  { addr: "0x7a1c4e0b9d2f3a6c8e1b5d7f9a2c4e6b8d0f1a3c", name: "Maya Chen", role: "Design", salary: 5_400 },
  { addr: "0x3f9e2d1c0b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e", name: "Kenji Sato", role: "Protocol", salary: 8_200 },
  { addr: "0xb4c8d2e6f0a1b3c5d7e9f2a4c6e8b0d2f4a6c8e0", name: "Ada Obi", role: "Growth", salary: 4_600 },
];

function nextFirst(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Landing() {
  const { connect, connecting, hasWallet } = useWallet();
  const now = useNow();
  const payday = nextFirst();
  const total = DEMO_TEAM.reduce((s, m) => s + m.salary, 0);

  return (
    <main className="container" style={{ paddingTop: 0 }}>
      <section className="hero">
        <div>
          <span className="pill">
            <span className="led" /> Live on LitVM LiteForge testnet
          </span>
          <h1>
            Monthly payroll,
            <br />
            <span className="soft">settled on-chain.</span>
          </h1>
          <p className="lead">
            Set salaries, pick a payday and pay your whole team in one transaction on Litecoin’s EVM layer. The next
            payroll is always reserved, and every payout is a verifiable payslip.
          </p>
          <div className="row wrap">
            <button className="btn btn-primary btn-lg" onClick={() => connect()} disabled={connecting}>
              {hasWallet ? (connecting ? "Connecting…" : "Launch app") : "Install a wallet"} <ArrowRight size={17} />
            </button>
            <a className="btn btn-ghost btn-lg" href="#how">
              How it works
            </a>
          </div>
        </div>

        <div className="glass demo" aria-label="Example payroll">
          <div className="demo-label">
            <span>{monthName(payday)} payroll</span>
            <span className="status active">
              <i />
              Funded
            </span>
          </div>
          <div className="big-amount num">
            {total.toLocaleString()}
            <span className="unit">LitUSD</span>
          </div>
          <div className="small faint num">
            Payday {fmtDate(payday)} · in {fmtDuration(payday - now / 1000, true)}
          </div>
          <div className="demo-rows">
            {DEMO_TEAM.map((m) => (
              <div className="demo-row" key={m.addr}>
                <Avatar address={m.addr} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{m.name}</div>
                  <div className="tiny faint">
                    {m.role} · <span className="mono">{shortAddr(m.addr)}</span>
                  </div>
                </div>
                <div className="num" style={{ textAlign: "right" }}>
                  {m.salary.toLocaleString()}
                  <div className="tiny faint">per month</div>
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-block" style={{ marginTop: 16 }} tabIndex={-1} aria-hidden>
            <Banknote size={15} /> Pay 3 people
          </button>
        </div>
      </section>

      <div className="features">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div className="glass feature" key={title}>
            <div className="icon">
              <Icon size={17} />
            </div>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>

      <div className="section-title" id="how">
        How it works
      </div>
      <div className="steps">
        <div className="glass step">
          <span className="n">01</span>
          <h3>Create a payroll</h3>
          <p>Pick LitUSD, zkLTC or any ERC-20, choose a payday and fund the treasury. Anyone can top it up later.</p>
        </div>
        <div className="glass step">
          <span className="n">02</span>
          <h3>Add your team</h3>
          <p>Add people one by one or paste a CSV. Each person confirms their payout wallet with one click.</p>
        </div>
        <div className="glass step">
          <span className="n">03</span>
          <h3>Run payroll on payday</h3>
          <p>Review the payouts and pay everyone in one transaction. Each payment becomes an exportable payslip.</p>
        </div>
      </div>

      <Footer />
    </main>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <span>{PROJECT_NAME} · built for the LitVM developer testnet</span>
      <span className="spacer" />
      {PAYROLL && (
        <a href={addressUrl(PAYROLL)} target="_blank" rel="noreferrer">
          Payroll contract {shortAddr(PAYROLL)}
        </a>
      )}
      {LUSD && (
        <a href={addressUrl(LUSD)} target="_blank" rel="noreferrer">
          LitUSD {shortAddr(LUSD)}
        </a>
      )}
      <span>Chain 4441</span>
    </footer>
  );
}
