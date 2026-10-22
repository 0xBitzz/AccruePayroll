import { useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, isAddress, zeroAddress, type Address } from "viem";
import {
  ArrowRightLeft,
  CalendarClock,
  Download,
  ExternalLink,
  Gift,
  Inbox,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Split,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { payrollAbi } from "../lib/generated";
import {
  PAYROLL,
  Status,
  fetchIncomingChanges,
  fetchMemberships,
  fetchPayslips,
  hasPendingChange,
  tokenMeta,
  usePoll,
  useToken,
  type IncomingChange,
  type MembershipView,
  type Payslip,
  type TokenMeta,
} from "../lib/data";
import { displayLabel, fmt, fmtDate, fmtDuration, memberName, ordinal, shortAddr } from "../lib/format";
import { downloadCsv } from "../lib/csv";
import { PROJECT_NAME } from "../lib/brand";
import { addressUrl } from "../lib/chain";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { CopyButton, Countdown, Modal, ReadError, Skeleton, StatusBadge } from "./ui";
import { ChangeWalletModal } from "./modals";

const payroll = { address: PAYROLL!, abi: payrollAbi } as const;

export function Employee() {
  const { account } = useWallet();
  const memberships = usePoll(account ? () => fetchMemberships(account) : null, [account], 10_000);
  const orgIds = (memberships.data ?? []).map((m) => m.orgId);
  const orgKey = orgIds.join(",");
  const slips = usePoll(account && orgIds.length ? () => fetchPayslips(account, orgIds) : null, [account, orgKey], 15_000);
  const incoming = usePoll(account ? () => fetchIncomingChanges(account) : null, [account], 30_000);
  const [splitFor, setSplitFor] = useState<MembershipView>();
  const [walletFor, setWalletFor] = useState<MembershipView>();

  if (memberships.loading) {
    return (
      <div className="stack">
        <Skeleton width={200} height={34} />
        <div className="glass stream-card" style={{ height: 220 }} />
      </div>
    );
  }

  if (memberships.error && !memberships.data) return <ReadError error={memberships.error} retry={memberships.reload} />;

  const list = memberships.data ?? [];
  const pending = incoming.data ?? [];

  if (!list.length && !pending.length) {
    if (incoming.error) return <ReadError error={incoming.error} retry={incoming.reload} />;
    if (incoming.loading) return <Skeleton width="100%" height={220} />;
    return (
      <div className="glass empty">
        <div className="icon">
          <Inbox size={22} />
        </div>
        <h2>You’re not on a payroll yet</h2>
        <p>
          Send this address to your employer. Once they add you, open this tab and select Confirm wallet on your
          payroll card. You confirm once for each payroll before receiving salaries or bonuses.
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <span className="pill mono">
            <span className="hide-sm">{account}</span>
            <span className="show-sm">{shortAddr(account)}</span>
          </span>
          <CopyButton text={account!} label="Copy" />
        </div>
      </div>
    );
  }

  const active = list.filter((m) => m.member.status === Status.Active).length;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {!!memberships.error && <ReadError error={memberships.error} retry={memberships.reload} />}
      {!!incoming.error && <ReadError error={incoming.error} retry={incoming.reload} />}
      <div className="page-head">
        <div>
          <div className="eyebrow">Your salary</div>
          <h1>{active > 1 ? `Paid by ${active} employers` : list.length ? "Monthly salary" : "Wallet change"}</h1>
          {list.length > 0 && (
            <p className="small muted">
              Your employer sends salaries and bonuses directly to your confirmed wallet. Once sent, funds are
              available in your wallet.
            </p>
          )}
        </div>
      </div>

      {pending.map((c) => (
        <IncomingCard key={`${c.orgId}-${c.from}`} c={c} since={incoming.fetchedAt} />
      ))}

      {list.map((m) => (
        <SalaryCard
          key={String(m.orgId)}
          m={m}
          since={memberships.fetchedAt}
          onSplit={() => setSplitFor(m)}
          onChangeWallet={() => setWalletFor(m)}
        />
      ))}

      {!!slips.error && <ReadError error={slips.error} retry={slips.reload} />}
      {list.length > 0 && <Payslips items={slips.data} loading={slips.loading} memberships={list} />}

      {splitFor && <SplitModal m={splitFor} onClose={() => setSplitFor(undefined)} />}
      {walletFor && (
        <ChangeWalletModal
          orgId={walletFor.orgId}
          account={walletFor.member.account}
          name={memberName(walletFor.member.label, walletFor.member.account)}
          byEmployer={false}
          onClose={() => setWalletFor(undefined)}
        />
      )}
    </div>
  );
}

function SalaryCard({
  m,
  since,
  onSplit,
  onChangeWallet,
}: {
  m: MembershipView;
  since: number;
  onSplit: () => void;
  onChangeWallet: () => void;
}) {
  const { meta: token, error: tokenError } = useToken(m.token);
  const { write, busy } = useTx();
  const mem = m.member;
  const confirmation = (
    <div className="confirm-box">
      <ShieldCheck size={20} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <strong>{mem.confirmed ? "Payout wallet confirmed" : "Confirm your payout wallet"}</strong>
        <div className="small muted">
          {mem.confirmed
            ? hasPendingChange(mem)
              ? "Payouts are held until your wallet change completes."
              : "Salaries and bonuses are sent directly here when your employer pays you."
            : "Confirm once for this payroll to receive salaries and bonuses. Confirming requires a small amount of zkLTC for gas."}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <a className="mono small" href={addressUrl(mem.account)} target="_blank" rel="noreferrer">
            {shortAddr(mem.account)} <ExternalLink size={12} />
          </a>
          <CopyButton text={mem.account} label="Copy address" />
        </div>
      </div>
      {!mem.confirmed && (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            write({ ...payroll, functionName: "confirmWallet", args: [m.orgId], title: `Confirm wallet for ${m.orgName}` })
          }
        >
          Confirm wallet
        </button>
      )}
    </div>
  );
  if (!token) return (
    <section className="glass stream-card">
      <div className="eyebrow" style={{ marginBottom: 16 }}>{m.orgName}</div>
      {confirmation}
      {tokenError ? <ReadError error={tokenError} /> : <Skeleton width="70%" height={30} />}
    </section>
  );

  const d = token.decimals;
  const chainNow = Number(m.timestamp);
  const employed = mem.status === Status.Active || mem.status === Status.Paused;
  const changing = hasPendingChange(mem);
  const changeLeft = Number(mem.changeReadyAt) - chainNow;

  return (
    <section className="glass stream-card">
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div>
          <div className="eyebrow">{m.orgName}</div>
          <div style={{ fontWeight: 500, marginTop: 2 }}>{displayLabel(mem.label, mem.account)}</div>
        </div>
        <span className="spacer" />
        <StatusBadge m={mem} />
      </div>

      {confirmation}

      <div className="stream-grid">
        <div>
          <div className="small muted">Monthly salary</div>
          <div className="big-amount num">
            {fmt(mem.salary, d, 2)}
            <span className="unit">{token.symbol}</span>
          </div>
          <div className="small faint">Paid on the {ordinal(m.payDay)} of every month</div>

          <div className="payday-row">
            <CalendarClock size={16} className="muted" />
            {mem.status === Status.Active ? (
              <span>
                Next payday <strong>{fmtDate(m.nextPayday)}</strong>
                <span className="faint">
                  {" "}
                  · in <Countdown seconds={Number(m.nextPayday) - chainNow} since={since} />
                </span>
              </span>
            ) : mem.status === Status.Paused ? (
              <span className="muted">Your salary is paused by your employer.</span>
            ) : (
              <span className="muted">You’re no longer on this payroll.</span>
            )}
          </div>

          <div className="row wrap" style={{ marginTop: 18 }}>
            <button className="btn" onClick={onSplit} disabled={!employed && mem.due === 0n}>
              <Split size={15} /> {mem.splitBps > 0 ? `Split ${mem.splitBps / 100}%` : "Auto-split"}
            </button>
            {!changing && (
              <button className="btn btn-ghost" onClick={onChangeWallet}>
                <KeyRound size={15} /> Change wallet
              </button>
            )}
          </div>
          <p className="small faint">
            Auto-split sets the share of future salaries and bonuses sent to another wallet. Your employer starts
            each payment.
          </p>
        </div>

        <dl className="kv">
          <dt>Sent to your wallets</dt>
          <dd className="num">
            {fmt(mem.totalPaid, d, 2)} {token.symbol}
          </dd>
          {mem.due > 0n && (
            <>
              <dt>Owed to you</dt>
              <dd className="num" style={{ color: "var(--warn)" }}>
                {fmt(mem.due, d, 2)} {token.symbol}
              </dd>
            </>
          )}
          <dt>Split</dt>
          <dd>{mem.splitBps > 0 ? `${mem.splitBps / 100}% → ${shortAddr(mem.splitTo)}` : "Off"}</dd>
          <dt>Payroll funded</dt>
          <dd style={m.funded ? undefined : { color: "var(--warn)" }}>{m.funded ? "Yes" : "Not yet"}</dd>
          <dt>Employer</dt>
          <dd className="mono">{shortAddr(m.orgOwner)}</dd>
        </dl>
      </div>

      {mem.due > 0n && mem.confirmed && !changing && (
        <div className="banner info" style={{ marginTop: 18 }}>
          <Wallet size={16} />
          <span>
            {fmt(mem.due, d, 2)} {token.symbol} from a past payday is waiting for your employer to run payroll.
          </span>
        </div>
      )}
      {changing && (
        <div className="banner" style={{ marginTop: 18 }}>
          <ShieldAlert size={16} />
          <span style={{ flex: 1 }}>
            Payouts are moving to {shortAddr(mem.pendingWallet)}.{" "}
            {changeLeft > 0
              ? `In ${fmtDuration(changeLeft)}, connect that wallet and accept the change.`
              : "Connect that wallet and accept the change."}{" "}
            Payouts are held until then. If you didn’t request this, cancel it now.
          </span>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              write({
                ...payroll,
                functionName: "cancelWalletChange",
                args: [m.orgId, mem.account],
                title: "Cancel wallet change",
              })
            }
          >
            Cancel change
          </button>
        </div>
      )}
      {!m.funded && mem.status === Status.Active && (
        <div className="banner" style={{ marginTop: 18 }}>
          <TriangleAlert size={16} />
          <span>Your employer’s treasury doesn’t fully cover the next payroll yet.</span>
        </div>
      )}
    </section>
  );
}

function IncomingCard({ c, since }: { c: IncomingChange; since: number }) {
  const { write, busy } = useTx();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = c.readyAt - c.chainNow - (now - since) / 1000;

  return (
    <section className="glass card">
      <div className="row wrap">
        <span className="feed-icon accent" style={{ width: 36, height: 36 }}>
          <ArrowRightLeft size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 500 }}>Move {c.orgName} payroll to this wallet</div>
          <div className="small muted">
            Requested for {shortAddr(c.from)}.{" "}
            {left > 0 ? `The 48-hour safety window ends in ${fmtDuration(left)}.` : "The safety window has passed."}
          </div>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || left > 0}
          onClick={() =>
            write({
              ...payroll,
              functionName: "acceptWalletChange",
              args: [c.orgId, c.from],
              title: `Accept ${c.orgName} payroll`,
            })
          }
        >
          Accept
        </button>
      </div>
    </section>
  );
}

function SplitModal({ m, onClose }: { m: MembershipView; onClose: () => void }) {
  const { write, busy } = useTx();
  const [to, setTo] = useState<string>(m.member.splitBps > 0 ? m.member.splitTo : "");
  const [pct, setPct] = useState(m.member.splitBps / 100 || 20);
  const bps = Math.round(pct * 100);
  const valid = bps === 0 || (isAddress(to) && to.toLowerCase() !== zeroAddress && to.toLowerCase() !== PAYROLL?.toLowerCase());

  const save = async (splitTo: Address, splitBps: number) => {
    const ok = await write({
      ...payroll,
      functionName: "setSplit",
      args: [m.orgId, splitTo, splitBps],
      title: splitBps === 0 ? "Turn off split" : `Split ${splitBps / 100}% to ${shortAddr(splitTo)}`,
    });
    if (ok) onClose();
  };

  return (
    <Modal
      title="Auto-split payouts"
      subtitle="Send a share of every salary and bonus somewhere else: savings, taxes, family."
      onClose={onClose}
    >
      <div className="stack">
        <div className="field">
          <label>Destination wallet</label>
          <input className="input mono" placeholder="0x…" value={to} autoFocus onChange={(e) => setTo(e.target.value.trim())} />
        </div>
        <div className="field">
          <div className="row">
            <label>Share</label>
            <span className="spacer" />
            <span className="num" style={{ fontWeight: 600 }}>
              {pct}%
            </span>
          </div>
          <input className="range" type="range" min={0} max={100} step={1} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          <span className="hint">
            Every payout: {100 - pct}% to you, {pct}% to {isAddress(to) ? shortAddr(to) : "the split wallet"}.
          </span>
        </div>
      </div>
      <div className="actions">
        {m.member.splitBps > 0 && (
          <button
            className="btn btn-ghost btn-danger"
            disabled={busy}
            onClick={() => save("0x0000000000000000000000000000000000000000", 0)}
          >
            Turn off
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !valid || bps === 0} onClick={() => save(getAddress(to), bps)}>
          Save split
        </button>
      </div>
    </Modal>
  );
}

function Payslips({
  items,
  loading,
  memberships,
}: {
  items?: Payslip[];
  loading: boolean;
  memberships: MembershipView[];
}) {
  const orgs = useMemo(() => new Map(memberships.map((m) => [String(m.orgId), m])), [memberships]);
  const [tokens, setTokens] = useState<Map<string, TokenMeta>>(new Map());
  const [tokenError, setTokenError] = useState<unknown>();

  useEffect(() => {
    let live = true;
    setTokenError(undefined);
    const unique = [...new Set(memberships.map((m) => m.token))];
    Promise.all(unique.map(tokenMeta))
      .then((metas) => live && setTokens(new Map(metas.map((t) => [t.address.toLowerCase(), t]))))
      .catch((error: unknown) => live && setTokenError(error));
    return () => { live = false; };
  }, [memberships]);

  const rows = (items ?? []).map((p) => {
    const org = orgs.get(String(p.orgId));
    const token = org ? tokens.get(org.token.toLowerCase()) : undefined;
    return { p, org, token };
  });

  const exportCsv = () =>
    downloadCsv(`${PROJECT_NAME}-payslips.csv`, [
      ["date", "employer", "type", "memo", "amount", "split_amount", "token"],
      ...rows.map(({ p, org, token }) => [
        new Date(p.at * 1000).toISOString(),
        org?.orgName ?? `Payroll #${p.orgId}`,
        p.bonus ? "bonus" : "salary",
        p.memo,
        token ? formatUnits(p.amount, token.decimals) : String(p.amount),
        token ? formatUnits(p.splitAmount, token.decimals) : String(p.splitAmount),
        token?.symbol ?? "",
      ]),
    ]);

  return (
    <section className="glass card slips">
      <div className="card-head">
        <div className="card-title">
          Payslips <span className="count">{rows.length || ""}</span>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={!rows.length || rows.some((r) => !r.token)} onClick={exportCsv}>
          <Download size={14} /> Export CSV
        </button>
      </div>
      {!!tokenError && <ReadError error={tokenError} />}
      {loading && !items ? (
        <div className="stack">
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </div>
      ) : !rows.length ? (
        <div className="small faint">Salaries and bonuses will appear here as on-chain payslips.</div>
      ) : (
        <div className="table">
          <div className="tr th">
            <span>Date</span>
            <span className="col-org">Employer</span>
            <span className="right">Amount</span>
            <span className="right col-split">Split</span>
            <span />
          </div>
          {rows.map(({ p, org, token }, i) => {
            const d = token?.decimals ?? 18;
            return (
              <div className="tr" key={`${p.orgId}-${p.at}-${i}`}>
                <span className="small">
                  <span className="row" style={{ gap: 8 }}>
                    <span className={`feed-icon ${p.bonus ? "accent" : "good"}`} style={{ width: 24, height: 24 }}>
                      {p.bonus ? <Gift size={12} /> : <Wallet size={12} />}
                    </span>
                    {fmtDate(p.at, false)}
                  </span>
                </span>
                <span className="col-org small" style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {org?.orgName ?? `Payroll #${p.orgId}`}
                  </div>
                  <div className="tiny faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.bonus ? `Bonus${p.memo ? ` · ${p.memo}` : ""}` : "Salary"}
                  </div>
                </span>
                <span className="right num">
                  {token ? fmt(p.amount, d, 2) : "…"} <span className="faint tiny">{token?.symbol}</span>
                </span>
                <span className="right num small col-split faint">{!token ? "…" : p.splitAmount > 0n ? fmt(p.splitAmount, d, 2) : "—"}</span>
                <span />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
