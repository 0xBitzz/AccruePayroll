import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Building2,
  CalendarClock,
  ChevronDown,
  Download,
  ExternalLink,
  Gift,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
  Repeat,
} from "lucide-react";
import { formatUnits, zeroAddress, type Address } from "viem";
import { payrollAbi } from "../lib/generated";
import {
  PAYROLL,
  Status,
  canBePaid,
  Action,
  fetchActivity,
  fetchOrg,
  fetchOwnedOrgs,
  fetchRoster,
  hasPendingChange,
  usePoll,
  useToken,
  type Entry,
  type MemberView,
  type OrgView,
  type TokenMeta,
} from "../lib/data";
import {
  addMonths,
  fmt,
  fmtDate,
  fmtDuration,
  memberName,
  monthName,
  ordinal,
  parseLabel,
  shortAddr,
  timeAgo,
} from "../lib/format";
import { addressUrl } from "../lib/chain";
import { downloadCsv } from "../lib/csv";
import { PROJECT_NAME } from "../lib/brand";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { Avatar, CopyButton, Countdown, Menu, ReadError, Skeleton, StatusBadge } from "./ui";
import {
  BonusModal,
  BulkImportModal,
  ChangeWalletModal,
  CreateOrgModal,
  FundModal,
  MemberModal,
  RunPayrollModal,
  TransferModal,
  WithdrawSurplusModal,
} from "./modals";

type ModalState =
  | { kind: "create" }
  | { kind: "fund" }
  | { kind: "withdraw" }
  | { kind: "run" }
  | { kind: "member"; member?: MemberView }
  | { kind: "bulk" }
  | { kind: "bonus"; preselect?: Address }
  | { kind: "wallet"; member: MemberView }
  | { kind: "transfer" }
  | null;

export function Employer() {
  const { account } = useWallet();
  const orgs = usePoll(account ? () => fetchOwnedOrgs(account) : null, [account], 20_000);
  const [selected, setSelected] = useState<bigint>();
  const [modal, setModal] = useState<ModalState>(null);
  // After creating a payroll, jump to it once the refetched list contains an id above this.
  const [awaitNewerThan, setAwaitNewerThan] = useState<bigint | null>(null);

  const list = orgs.data ?? [];
  const maxId = list.reduce((m, o) => (o.id > m ? o.id : m), 0n);
  useEffect(() => {
    if (!list.length) return;
    if (awaitNewerThan !== null && maxId > awaitNewerThan) {
      setSelected(maxId);
      setAwaitNewerThan(null);
    } else if (selected === undefined || !list.some((o) => o.id === selected)) {
      setSelected(list[0].id);
    }
  }, [list, maxId, selected, awaitNewerThan]);

  const create = modal?.kind === "create" && (
    <CreateOrgModal onClose={() => setModal(null)} onCreated={() => setAwaitNewerThan(maxId)} />
  );

  if (orgs.loading) {
    return (
      <div className="stack">
        <Skeleton width={220} height={34} />
        <div className="stats">
          {[0, 1, 2, 3].map((i) => (
            <div className="glass stat" key={i}>
              <Skeleton width="50%" />
              <div style={{ height: 14 }} />
              <Skeleton width="80%" height={26} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (orgs.error && !orgs.data) return <ReadError error={orgs.error} retry={orgs.reload} />;

  if (!list.length) {
    return (
      <>
        <div className="glass empty">
          <div className="icon">
            <Building2 size={22} />
          </div>
          <h2>Start your first payroll</h2>
          <p>Pick a payday, fund a treasury in LitUSD or zkLTC, and pay your whole team their monthly salary in one transaction.</p>
          <button className="btn btn-primary btn-lg" onClick={() => setModal({ kind: "create" })}>
            <Plus size={17} /> New payroll
          </button>
          <p className="small faint" style={{ margin: "18px auto 0" }}>
            Here to get paid or to confirm your wallet? Switch to <strong>Employee</strong> at the top.
          </p>
        </div>
        {create}
      </>
    );
  }

  return (
    <>
      {selected !== undefined && (
        <OrgDashboard
          key={String(selected)}
          orgId={selected}
          orgs={list}
          onSelect={setSelected}
          modal={modal}
          setModal={setModal}
          onOrgsChanged={orgs.reload}
        />
      )}
      {create}
    </>
  );
}

function OrgDashboard({
  orgId,
  orgs,
  onSelect,
  modal,
  setModal,
  onOrgsChanged,
}: {
  orgId: bigint;
  orgs: OrgView[];
  onSelect: (id: bigint) => void;
  modal: ModalState;
  setModal: (m: ModalState) => void;
  onOrgsChanged: () => void;
}) {
  const snap = usePoll(() => Promise.all([fetchOrg(orgId), fetchRoster(orgId)]), [orgId], 10_000);
  const activity = usePoll(() => fetchActivity(orgId), [orgId], 15_000);
  const [org, roster] = snap.data ?? [];
  const { meta: token, error: tokenError } = useToken(org?.token);
  const [showEnded, setShowEnded] = useState(false);
  const { write, busy } = useTx();

  if (snap.error && !snap.data) return <ReadError error={snap.error} retry={snap.reload} />;
  if (tokenError) return <ReadError error={tokenError} />;

  if (!org || !roster || !token) {
    return (
      <div className="stack">
        <Skeleton width={260} height={34} />
        <div className="glass card" style={{ height: 240 }} />
      </div>
    );
  }

  const d = token.decimals;
  const since = snap.fetchedAt;
  const chainNow = Number(org.timestamp);
  const ended = roster.filter((m) => m.status === Status.Terminated && m.due === 0n);
  const visible = showEnded ? roster : roster.filter((m) => !ended.includes(m));
  const payees = roster.filter((m) => m.due > 0n && canBePaid(m));
  const unconfirmed = roster.filter((m) => !m.confirmed && m.status !== Status.None);
  const changes = roster.filter(hasPendingChange);
  const close = () => setModal(null);
  const appLink = window.location.origin;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {!!snap.error && <ReadError error={snap.error} retry={snap.reload} />}
      <div className="page-head">
        <div>
          <Menu
            align="left"
            trigger={(_, toggle) => (
              <button className="pill" onClick={toggle}>
                <Building2 size={13} /> {orgs.length} {orgs.length === 1 ? "payroll" : "payrolls"} <ChevronDown size={13} />
              </button>
            )}
          >
            {(closeMenu) => (
              <>
                <div className="menu-label">Your payrolls</div>
                {orgs.map((o) => (
                  <button
                    key={String(o.id)}
                    aria-current={o.id === orgId}
                    onClick={() => {
                      closeMenu();
                      onSelect(o.id);
                    }}
                  >
                    <Building2 size={15} className="faint" /> {o.name}
                    <span className="spacer" />
                    <span className="tiny faint">#{String(o.id)}</span>
                  </button>
                ))}
                <div className="sep" />
                <button
                  onClick={() => {
                    closeMenu();
                    setModal({ kind: "create" });
                  }}
                >
                  <Plus size={15} /> New payroll
                </button>
              </>
            )}
          </Menu>
          <h1>{org.name}</h1>
          <div className="eyebrow" style={{ marginTop: 6 }}>
            <span>Paid in {token.symbol}</span>·<span>Payday: the {ordinal(org.payDay)}</span>·<span>#{String(org.id)}</span>
          </div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setModal({ kind: "withdraw" })} disabled={org.surplus === 0n}>
            <ArrowUpFromLine size={15} /> <span className="hide-sm">Withdraw</span>
          </button>
          <button className="btn" onClick={() => setModal({ kind: "fund" })}>
            <ArrowDownToLine size={15} /> Fund
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setModal({ kind: "run" })}
            disabled={org.payable_ === 0n}
            title={org.payable_ === 0n ? `Next payday: ${fmtDate(org.nextPayday)}` : undefined}
          >
            <Banknote size={15} /> Run payroll
          </button>
          <Menu
            trigger={(_, toggle) => (
              <button className="btn btn-icon" style={{ width: 40 }} onClick={toggle} aria-label="More">
                <MoreHorizontal size={16} />
              </button>
            )}
          >
            {(closeMenu) => (
              <>
                <button
                  onClick={() => {
                    closeMenu();
                    setModal({ kind: "transfer" });
                  }}
                >
                  <Repeat size={15} /> Transfer ownership
                </button>
                <a href={addressUrl(PAYROLL!)} target="_blank" rel="noreferrer" onClick={closeMenu}>
                  <ExternalLink size={15} /> Contract on explorer
                </a>
              </>
            )}
          </Menu>
        </div>
      </div>

      <Stats org={org} token={token} since={since} />

      {org.payable_ > 0n && (
        <div className="banner info">
          <Banknote size={16} />
          <span style={{ flex: 1 }}>
            Payroll is ready: {fmt(org.payable_, d, 2)} {token.symbol} for {payees.length}{" "}
            {payees.length === 1 ? "person" : "people"}.
            {org.payable_ > org.treasury && ` The treasury is ${fmt(org.payable_ - org.treasury, d, 2)} short.`}
          </span>
          {org.payable_ > org.treasury ? (
            <button className="btn btn-sm" onClick={() => setModal({ kind: "fund" })}>
              Fund
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: "run" })}>
              Run payroll
            </button>
          )}
        </div>
      )}
      {org.payable_ === 0n && org.shortfall > 0n && (
        <div className="banner">
          <TriangleAlert size={16} />
          <span style={{ flex: 1 }}>
            The treasury doesn’t cover the payroll due on {fmtDate(org.nextPayday)}. Fund {fmt(org.shortfall, d, 2)}{" "}
            {token.symbol} more.
          </span>
          <button className="btn btn-sm" onClick={() => setModal({ kind: "fund" })}>
            Fund
          </button>
        </div>
      )}
      {unconfirmed.length > 0 && (
        <div className="banner info">
          <ShieldCheck size={16} />
          <span style={{ flex: 1 }}>
            {unconfirmed.map((m) => memberName(m.label, m.account)).join(", ")}{" "}
            {unconfirmed.length === 1 ? "hasn’t" : "haven’t"} confirmed their payout wallet. Share the app link: they
            connect that wallet and confirm under Employee. Their salary is held until then.
          </span>
          <CopyButton text={appLink} label="Copy link" />
        </div>
      )}
      {changes.map((m) => {
        const left = Number(m.changeReadyAt) - chainNow;
        return (
          <div className="banner" key={m.account}>
            <ShieldAlert size={16} />
            <span style={{ flex: 1 }}>
              Wallet change requested for {memberName(m.label, m.account)}: {shortAddr(m.account)} →{" "}
              {shortAddr(m.pendingWallet)}.{" "}
              {left > 0 ? `It can complete in ${fmtDuration(left)}.` : "It can be accepted now."} Payouts are held. If
              you didn’t expect this, block it.
            </span>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                write({
                  address: PAYROLL!,
                  abi: payrollAbi,
                  functionName: "cancelWalletChange",
                  args: [org.id, m.account],
                  title: `Block wallet change for ${memberName(m.label, m.account)}`,
                })
              }
            >
              Block
            </button>
          </div>
        );
      })}
      {org.treasury === 0n && roster.length === 0 && (
        <div className="banner info">
          <Sparkles size={16} />
          <span style={{ flex: 1 }}>
            Fund the treasury, then add your team. Everyone active on the {ordinal(org.payDay)} gets their full salary.
          </span>
        </div>
      )}

      <div className="grid-2">
        <section className="glass card">
          <div className="card-head">
            <div className="card-title">
              <Users size={16} className="muted" /> Team <span className="count">{String(org.headcount)}</span>
            </div>
            <div className="row wrap">
              {ended.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowEnded((s) => !s)}>
                  {showEnded ? "Hide" : "Show"} ended ({ended.length})
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setModal({ kind: "bonus" })} disabled={org.headcount === 0n}>
                <Gift size={14} /> Bonus
              </button>
              <button className="btn btn-sm hide-sm" onClick={() => setModal({ kind: "bulk" })}>
                Bulk import
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: "member" })}>
                <UserPlus size={14} /> Add
              </button>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="empty" style={{ padding: "32px 12px" }}>
              <p style={{ marginBottom: 14 }}>No one on this payroll yet.</p>
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn btn-sm" onClick={() => setModal({ kind: "bulk" })}>
                  Paste a CSV
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: "member" })}>
                  <UserPlus size={14} /> Add someone
                </button>
              </div>
            </div>
          ) : (
            <div className="table">
              <div className="tr th">
                <span>Member</span>
                <span className="right col-salary">Salary / mo</span>
                <span className="right">Paid to date</span>
                <span className="col-status">Status</span>
                <span />
              </div>
              {visible.map((m) => (
                <MemberRow key={m.account} m={m} org={org} token={token} setModal={setModal} />
              ))}
            </div>
          )}
        </section>

        <ActivityCard
          entries={activity.data?.entries}
          loading={activity.loading}
          token={token}
          roster={roster}
          org={org}
        />
      </div>

      {modal?.kind === "fund" && <FundModal org={org} token={token} onClose={close} />}
      {modal?.kind === "withdraw" && <WithdrawSurplusModal org={org} token={token} onClose={close} />}
      {modal?.kind === "run" && (
        <RunPayrollModal org={org} token={token} members={roster} onClose={close} onFund={() => setModal({ kind: "fund" })} />
      )}
      {modal?.kind === "member" && <MemberModal org={org} token={token} member={modal.member} onClose={close} />}
      {modal?.kind === "bulk" && <BulkImportModal org={org} token={token} onClose={close} />}
      {modal?.kind === "bonus" && (
        <BonusModal org={org} token={token} members={roster} preselect={modal.preselect} onClose={close} />
      )}
      {modal?.kind === "wallet" && (
        <ChangeWalletModal
          orgId={org.id}
          account={modal.member.account}
          name={memberName(modal.member.label, modal.member.account)}
          byEmployer
          onClose={close}
        />
      )}
      {modal?.kind === "transfer" && <TransferModal org={org} onClose={close} onDone={onOrgsChanged} />}
    </div>
  );
}

function Stats({ org, token, since }: { org: OrgView; token: TokenMeta; since: number }) {
  const d = token.decimals;
  const chainNow = Number(org.timestamp);
  const toPayday = Number(org.nextPayday) - chainNow;
  const paydays = org.totalSalary > 0n && org.treasury > org.due ? (org.treasury - org.due) / org.totalSalary : 0n;
  const fundedThrough = paydays > 0n ? addMonths(org.nextPayday, Number(paydays) - 1) : null;
  const health = org.totalSalary === 0n ? "" : paydays < 1n ? "bad" : paydays < 3n ? "warn" : "";

  return (
    <div className="stats">
      <div className="glass stat">
        <div className="label">
          <Wallet size={13} /> Treasury
        </div>
        <div className="value num">
          {fmt(org.treasury, d, 2)}
          <small>{token.symbol}</small>
        </div>
        <div className="sub">Paid out {fmt(org.totalPaid, d, 2)} all-time</div>
      </div>
      <div className="glass stat">
        <div className="label">
          <CalendarClock size={13} /> Next payday
        </div>
        <div className="value">{fmtDate(org.nextPayday, false)}</div>
        <div className="sub">
          in <Countdown seconds={toPayday} since={since} />
        </div>
      </div>
      <div className="glass stat">
        <div className="label">Next payroll</div>
        <div className="value num">
          {fmt(org.totalSalary, d, 2)}
          <small>{token.symbol}</small>
        </div>
        <div className="sub" style={org.shortfall > 0n ? { color: "var(--bad)" } : undefined}>
          {org.shortfall > 0n
            ? `Short by ${fmt(org.shortfall, d, 2)}`
            : org.due > 0n
              ? `+ ${fmt(org.due, d, 2)} due now · reserved`
              : "Reserved in treasury"}
        </div>
      </div>
      <div className="glass stat">
        <div className="label">Funded through</div>
        <div className="value">{org.totalSalary === 0n ? "—" : fundedThrough ? fmtDate(fundedThrough, false) : "Not funded"}</div>
        <div className={`meter ${health}`}>
          <i style={{ width: `${org.totalSalary === 0n ? 0 : Math.min(100, (Number(paydays) / 6) * 100)}%` }} />
        </div>
        <div className="sub">
          {org.totalSalary === 0n
            ? "No salaries yet"
            : `${String(paydays)} ${paydays === 1n ? "payday" : "paydays"} covered`}
        </div>
      </div>
    </div>
  );
}

function MemberRow({
  m,
  org,
  token,
  setModal,
}: {
  m: MemberView;
  org: OrgView;
  token: TokenMeta;
  setModal: (m: ModalState) => void;
}) {
  const { write, busy } = useTx();
  const { name, role } = parseLabel(m.label);
  const who = name || shortAddr(m.account);
  const act = (functionName: string, title: string) =>
    write({ address: PAYROLL!, abi: payrollAbi, functionName, args: [org.id, m.account], title });

  return (
    <div className={`tr ${m.status === Status.Terminated ? "faded" : ""}`}>
      <div className="who">
        <Avatar address={m.account} />
        <div className="meta">
          <div className="name">{who}</div>
          <div className="sub">
            {role && <span className="role">{role}</span>}
            <a className="addr" href={addressUrl(m.account)} target="_blank" rel="noreferrer">
              {shortAddr(m.account)}
            </a>
          </div>
        </div>
      </div>
      <span className="right num col-salary">{fmt(m.salary, token.decimals, 2)}</span>
      <span className="right num">
        {fmt(m.totalPaid, token.decimals, 2)}
        {m.due > 0n && <div className="tiny" style={{ color: "var(--warn)" }}>{fmt(m.due, token.decimals, 2)} owed</div>}
      </span>
      <span className="col-status">
        <StatusBadge m={m} />
      </span>
      <Menu
        trigger={(_, toggle) => (
          <button className="btn btn-ghost btn-sm btn-icon" onClick={toggle} aria-label={`Actions for ${who}`}>
            <MoreHorizontal size={16} />
          </button>
        )}
      >
        {(close) => {
          const run = (fn: () => void) => () => {
            close();
            fn();
          };
          const walletItems = hasPendingChange(m) ? (
            <button disabled={busy} onClick={run(() => act("cancelWalletChange", `Block wallet change for ${who}`))}>
              <ShieldAlert size={15} /> Block wallet change
            </button>
          ) : (
            <button onClick={run(() => setModal({ kind: "wallet", member: m }))}>
              <KeyRound size={15} /> Change wallet…
            </button>
          );
          if (m.status === Status.Terminated)
            return (
              <>
                <button onClick={run(() => setModal({ kind: "member", member: m }))}>
                  <UserCheck size={15} /> Re-hire
                </button>
                {walletItems}
              </>
            );
          return (
            <>
              <button onClick={run(() => setModal({ kind: "member", member: m }))}>
                <Pencil size={15} /> Change salary
              </button>
              {canBePaid(m) && (
                <button onClick={run(() => setModal({ kind: "bonus", preselect: m.account }))}>
                  <Gift size={15} /> Send bonus
                </button>
              )}
              {m.status === Status.Active ? (
                <button disabled={busy} onClick={run(() => act("pauseMember", `Pause ${who}`))}>
                  <Pause size={15} /> Pause salary
                </button>
              ) : (
                <button disabled={busy} onClick={run(() => act("resumeMember", `Resume ${who}`))}>
                  <Play size={15} /> Resume salary
                </button>
              )}
              {walletItems}
              <div className="sep" />
              <button className="danger" disabled={busy} onClick={run(() => act("terminateMember", `Remove ${who}`))}>
                <Square size={15} /> Remove from payroll
              </button>
            </>
          );
        }}
      </Menu>
    </div>
  );
}

type Line = { icon: typeof Sparkles; tone: string; text: string };

/** The month a payroll run paid for: the payday at or before the run (pay days are 1-28, 00:00 UTC). */
function paydayMonth(at: number, payDay: number): string {
  const d = new Date(at * 1000);
  const m = d.getUTCDate() >= payDay ? d.getUTCMonth() : d.getUTCMonth() - 1;
  return monthName(Date.UTC(d.getUTCFullYear(), m, payDay) / 1000);
}

function describe(e: Entry, org: OrgView, token: TokenMeta, names: Map<string, string>): Line {
  const amt = (v: bigint) => `${fmt(v, token.decimals, 2)} ${token.symbol}`;
  const who = (addr: string) => names.get(addr.toLowerCase()) ?? shortAddr(addr);
  switch (e.action) {
    case Action.Created:
      return { icon: Sparkles, tone: "accent", text: `Payroll created · payday the ${ordinal(Number(e.extra))}` };
    case Action.Deposited:
      return { icon: ArrowDownToLine, tone: "good", text: `${shortAddr(e.who)} funded ${amt(e.amount)}` };
    case Action.Withdrew:
      return { icon: ArrowUpFromLine, tone: "", text: `Withdrew ${amt(e.amount)} surplus to ${shortAddr(e.who)}` };
    case Action.Added:
      return { icon: UserPlus, tone: "accent", text: `Added ${who(e.who)} at ${amt(e.amount)}/mo` };
    case Action.SalaryChanged:
      return { icon: Pencil, tone: "accent", text: `${who(e.who)}: ${amt(e.extra)} → ${amt(e.amount)}/mo` };
    case Action.Paused:
      return { icon: Pause, tone: "warn", text: `Paused ${who(e.who)}’s salary` };
    case Action.Resumed:
      return { icon: Play, tone: "good", text: `Resumed ${who(e.who)}’s salary` };
    case Action.Removed:
      return { icon: UserMinus, tone: "", text: `Removed ${who(e.who)} from payroll` };
    case Action.PayrollRun:
      return {
        icon: Banknote,
        tone: "good",
        text: `Ran ${paydayMonth(e.at, org.payDay)} payroll · ${amt(e.amount)} to ${String(e.extra)} ${e.extra === 1n ? "person" : "people"}`,
      };
    case Action.PaymentFailed:
      return { icon: TriangleAlert, tone: "warn", text: `Payment to ${who(e.who)} failed · ${amt(e.amount)} still owed` };
    case Action.Bonus:
      return { icon: Gift, tone: "accent", text: `Bonus ${amt(e.amount)} → ${who(e.who)}${e.memo ? ` · “${e.memo}”` : ""}` };
    case Action.WalletConfirmed:
      return { icon: ShieldCheck, tone: "good", text: `${who(e.who)} confirmed their wallet` };
    case Action.WalletChangeRequested:
      return { icon: KeyRound, tone: "warn", text: `Wallet change requested for ${who(e.who)} → ${shortAddr(e.other)}` };
    case Action.WalletChangeCancelled:
      return { icon: ShieldAlert, tone: "", text: `Wallet change for ${who(e.who)} blocked` };
    case Action.WalletChanged:
      return { icon: Link2, tone: "accent", text: `${who(e.who)} moved payouts ${shortAddr(e.other)} → ${shortAddr(e.who)}` };
    case Action.OwnershipTransferred:
      return { icon: Repeat, tone: "warn", text: `Ownership → ${shortAddr(e.other)}` };
    default:
      return { icon: Sparkles, tone: "", text: "Update" };
  }
}

function describeGroup(group: Entry[], org: OrgView, token: TokenMeta, names: Map<string, string>): Line {
  const first = describe(group[0], org, token, names);
  if (group.length === 1) return first;
  const n = group.length;
  if (group[0].action === Action.Bonus) {
    const total = group.reduce((s, e) => s + e.amount, 0n);
    const memo = group[0].memo;
    return {
      ...first,
      text: `Bonus round · ${fmt(total, token.decimals, 2)} ${token.symbol} across ${n} people${memo ? ` · “${memo}”` : ""}`,
    };
  }
  if (group[0].action === Action.Added) {
    const who = group.map((e) => names.get(e.who.toLowerCase()) ?? shortAddr(e.who));
    return { ...first, text: `Onboarded ${n} people: ${who.slice(0, 3).join(", ")}${n > 3 ? ` +${n - 3}` : ""}` };
  }
  if (group[0].action === Action.WalletConfirmed) {
    const who = group.map((e) => names.get(e.who.toLowerCase()) ?? shortAddr(e.who));
    return { ...first, text: `${who.join(", ")} confirmed their wallets` };
  }
  return { ...first, text: `${first.text} (+${n - 1} more)` };
}

function ActivityCard({
  entries,
  loading,
  token,
  roster,
  org,
}: {
  entries?: Entry[];
  loading: boolean;
  token: TokenMeta;
  roster: MemberView[];
  org: OrgView;
}) {
  const names = useMemo(
    () => new Map(roster.map((m) => [m.account.toLowerCase(), memberName(m.label, m.account)])),
    [roster],
  );
  const groups = useMemo(() => {
    const out: Entry[][] = [];
    for (const e of entries ?? []) {
      const last = out[out.length - 1];
      if (last && last[0].action === e.action && last[0].at === e.at) last.push(e);
      else out.push([e]);
    }
    return out;
  }, [entries]);

  const exportCsv = () => {
    if (!entries) return;
    downloadCsv(`${PROJECT_NAME}-${org.name.replace(/\W+/g, "-").toLowerCase()}-activity.csv`, [
      ["date", "action", "description", "amount", "token", "address"],
      ...entries.map((e) => [
        new Date(e.at * 1000).toISOString(),
        Action[e.action],
        describe(e, org, token, names).text,
        e.amount > 0n ? formatUnits(e.amount, token.decimals) : "",
        token.symbol,
        e.who !== zeroAddress ? e.who : "",
      ]),
    ]);
  };

  return (
    <section className="glass card">
      <div className="card-head">
        <div className="card-title">Activity</div>
        <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!entries?.length}>
          <Download size={14} /> CSV
        </button>
      </div>
      {loading && !entries ? (
        <div className="stack">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={`${90 - i * 12}%`} />
          ))}
        </div>
      ) : !groups.length ? (
        <div className="small faint">Nothing yet. Deposits, hires and payroll runs will show up here.</div>
      ) : (
        <div className="feed">
          {groups.map((group) => {
            const e = group[0];
            const { icon: Icon, tone, text } = describeGroup(group, org, token, names);
            return (
              <div className="feed-item" key={e.index}>
                <span className={`feed-icon ${tone}`}>
                  <Icon size={14} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ wordBreak: "break-word" }}>{text}</div>
                  <div className="when" title={new Date(e.at * 1000).toUTCString()}>
                    {timeAgo(e.at)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
