import { useMemo, useState, type ReactNode } from "react";
import { erc20Abi, formatUnits, getAddress, isAddress, maxUint128, maxUint256, zeroAddress, type Address } from "viem";
import { Droplets, ShieldCheck, TriangleAlert } from "lucide-react";
import { payrollAbi, lusdAbi } from "../lib/generated";
import {
  LUSD,
  PAYROLL,
  Status,
  allowance,
  balanceOf,
  canBePaid,
  lusdReadyAt,
  usePoll,
  type MemberView,
  type OrgView,
  type TokenMeta,
} from "../lib/data";
import {
  displayLabel,
  fmt,
  fmtDate,
  formatLabel,
  memberName,
  ordinal,
  parseAmount,
  parseLabel,
  shortAddr,
} from "../lib/format";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { parseBulkMembers } from "../lib/bulk-import";
import { Avatar, Modal, ReadError } from "./ui";

const safeParse = (v: string, decimals: number) => {
  try {
    return parseAmount(v, decimals);
  } catch {
    return null;
  }
};

/** The first payday after now for a given pay day (00:00 UTC), mirroring Calendar.period(...).end. */
function nextPaydayFor(payDay: number, nowMs = Date.now()): number {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = Date.UTC(y, m, payDay);
  return (thisMonth > nowMs ? thisMonth : Date.UTC(y, m + 1, payDay)) / 1000;
}

function AmountInput({
  value,
  onChange,
  symbol,
  max,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  symbol: string;
  max?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="input-wrap">
      <input
        className="input has-suffix num"
        inputMode="decimal"
        placeholder="0.00"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="input-suffix">
        {max !== undefined && (
          <button type="button" onClick={() => onChange(max)}>
            MAX
          </button>
        )}
        {symbol}
      </div>
    </div>
  );
}

const payroll = { address: PAYROLL!, abi: payrollAbi } as const;
const Bad = ({ children }: { children: ReactNode }) => (
  <span className="hint" style={{ color: "var(--bad)" }}>
    {children}
  </span>
);

export function CreateOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { write, busy } = useTx();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"native" | "lusd" | "custom">(LUSD ? "lusd" : "native");
  const [custom, setCustom] = useState("");
  const [payDay, setPayDay] = useState(1);
  const token: Address | null =
    kind === "native" ? zeroAddress : kind === "lusd" ? LUSD : isAddress(custom) ? getAddress(custom) : null;

  const submit = async () => {
    if (!token) return;
    const ok = await write({
      ...payroll,
      title: `Create “${name.trim()}”`,
      functionName: "createOrg",
      args: [name.trim(), token, payDay],
    });
    if (ok) {
      onCreated();
      onClose();
    }
  };

  return (
    <Modal title="New payroll" subtitle="A payroll holds a treasury and a team. You can run several." onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label>Organisation name</label>
          <input
            className="input"
            placeholder="e.g. Silverline Labs"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
          />
        </div>
        <div className="field">
          <label>Pay salaries in</label>
          <div className="choice-grid">
            <button className="choice" aria-pressed={kind === "lusd"} onClick={() => setKind("lusd")} disabled={!LUSD}>
              <strong>LitUSD</strong>
              <span>Test stablecoin</span>
            </button>
            <button className="choice" aria-pressed={kind === "native"} onClick={() => setKind("native")}>
              <strong>zkLTC</strong>
              <span>Native token</span>
            </button>
            <button className="choice" aria-pressed={kind === "custom"} onClick={() => setKind("custom")}>
              <strong>Custom</strong>
              <span>Any ERC-20</span>
            </button>
          </div>
        </div>
        {kind === "custom" && (
          <div className="field">
            <label>Token address</label>
            <input className="input mono" placeholder="0x…" value={custom} onChange={(e) => setCustom(e.target.value.trim())} />
          </div>
        )}
        <div className="field">
          <label>Payday</label>
          <select className="select" value={payDay} onChange={(e) => setPayDay(Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {ordinal(d)} of every month
              </option>
            ))}
          </select>
          <span className="hint">
            Salaries are paid in full each payday (00:00 UTC). First payday: {fmtDate(nextPaydayFor(payDay))}.
          </span>
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !name.trim() || !token} onClick={submit}>
          Create payroll
        </button>
      </div>
    </Modal>
  );
}

export function FundModal({ org, token, onClose }: { org: OrgView; token: TokenMeta; onClose: () => void }) {
  const { account } = useWallet();
  const { write, busy } = useTx();
  const [amount, setAmount] = useState("");
  const isLusd = !!LUSD && token.address.toLowerCase() === LUSD.toLowerCase();
  const funds = usePoll(account ? () => Promise.all([
    balanceOf(token, account),
    token.native ? Promise.resolve(0n) : allowance(token.address, account),
    isLusd ? lusdReadyAt(account) : Promise.resolve(0),
  ]) : null, [account, token.address, isLusd], 15_000);
  const [bal, allowed, dripAt] = funds.data ?? [];

  const value = safeParse(amount, token.decimals);
  const needsApproval = !token.native && value !== null && allowed !== undefined && allowed < value;
  const tooMuch = value !== null && bal !== undefined && value > bal;
  const available = org.treasury + (value ?? 0n) - org.due;
  const paydaysAfter = org.totalSalary > 0n && value ? (available > 0n ? available / org.totalSalary : 0n) : null;

  const submit = async () => {
    if (!value || !funds.data || funds.error) return;
    if (needsApproval) {
      await write({
        title: `Approve ${token.symbol}`,
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [PAYROLL!, maxUint256],
      });
      return;
    }
    const ok = await write({
      ...payroll,
      title: `Deposit ${fmt(value, token.decimals)} ${token.symbol}`,
      functionName: "deposit",
      args: [org.id, value],
      value: token.native ? value : undefined,
    });
    if (ok) onClose();
  };

  const canDrip = dripAt !== undefined && dripAt * 1000 <= Date.now() && !funds.error;
  const gasBuffer = 10n ** 16n;

  return (
    <Modal title="Fund treasury" subtitle={`Top up ${org.name}. Anyone can fund any payroll.`} onClose={onClose}>
      <div className="stack">
        {!!funds.error && <ReadError error={funds.error} retry={funds.reload} />}
        <div className="field">
          <div className="row">
            <label>Amount</label>
            <span className="spacer" />
            <span className="tiny faint num">
              Wallet: {bal !== undefined ? fmt(bal, token.decimals) : "…"} {token.symbol}
            </span>
          </div>
          <AmountInput
            value={amount}
            onChange={setAmount}
            symbol={token.symbol}
            autoFocus
            max={
              bal !== undefined
                ? fmt(token.native ? (bal > gasBuffer ? bal - gasBuffer : 0n) : bal, token.decimals, token.decimals).replace(/,/g, "")
                : undefined
            }
          />
          {paydaysAfter !== null && (
            <span className="hint">
              Treasury will cover {String(paydaysAfter)} {paydaysAfter === 1n ? "payday" : "paydays"} at{" "}
              {fmt(org.totalSalary, token.decimals, 2)} {token.symbol}/month.
            </span>
          )}
          {tooMuch && <Bad>That’s more than your wallet balance.</Bad>}
        </div>
        {isLusd && (
          <div className="banner info">
            <Droplets size={16} />
            <span style={{ flex: 1 }}>Need test LitUSD? The faucet drips 50,000 per hour.</span>
            <button
              className="btn btn-sm"
              disabled={busy || !canDrip}
              onClick={() => write({ title: "Drip 50,000 LitUSD", address: LUSD!, abi: lusdAbi, functionName: "drip" })}
            >
              {dripAt === undefined || funds.error ? "Loading…" : canDrip ? "Drip" : `Ready ${new Date(dripAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            </button>
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !value || tooMuch || !funds.data || !!funds.error} onClick={submit}>
          {needsApproval ? `Approve ${token.symbol}` : "Deposit"}
        </button>
      </div>
    </Modal>
  );
}

export function WithdrawSurplusModal({ org, token, onClose }: { org: OrgView; token: TokenMeta; onClose: () => void }) {
  const { account } = useWallet();
  const { write, busy } = useTx();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState<string>(account ?? "");
  const value = safeParse(amount, token.decimals);

  const submit = async () => {
    if (!value || !isAddress(to)) return;
    const ok = await write({
      ...payroll,
      title: `Withdraw ${fmt(value, token.decimals)} ${token.symbol}`,
      functionName: "withdrawSurplus",
      args: [org.id, value, getAddress(to)],
    });
    if (ok) onClose();
  };

  return (
    <Modal title="Withdraw surplus" subtitle="Owed salaries and the next payroll always stay in the treasury." onClose={onClose}>
      <div className="stack">
        <div className="field">
          <div className="row">
            <label>Amount</label>
            <span className="spacer" />
            <span className="tiny faint num">
              Surplus: {fmt(org.surplus, token.decimals)} {token.symbol}
            </span>
          </div>
          <AmountInput
            value={amount}
            onChange={setAmount}
            symbol={token.symbol}
            autoFocus
            max={fmt(org.surplus, token.decimals, token.decimals).replace(/,/g, "")}
          />
          {value !== null && value > org.surplus && (
            <Bad>
              Exceeds surplus. {fmt(org.reserved, token.decimals)} {token.symbol} is reserved for owed salaries and the
              next payroll.
            </Bad>
          )}
        </div>
        <div className="field">
          <label>Send to</label>
          <input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} />
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !value || value > org.surplus || !isAddress(to) || to.toLowerCase() === zeroAddress || to.toLowerCase() === PAYROLL?.toLowerCase()}
          onClick={submit}
        >
          Withdraw
        </button>
      </div>
    </Modal>
  );
}

export function MemberModal({
  org,
  token,
  member,
  onClose,
}: {
  org: OrgView;
  token: TokenMeta;
  member?: MemberView;
  onClose: () => void;
}) {
  const { write, busy } = useTx();
  const editing = !!member && (member.status === Status.Active || member.status === Status.Paused);
  const [address, setAddress] = useState<string>(member?.account ?? "");
  const [who, setWho] = useState(member ? formatLabel(parseLabel(member.label)) : "");
  const [salary, setSalary] = useState(member ? formatUnits(member.salary, token.decimals) : "");
  const person = parseLabel(who);
  const current = member ? parseLabel(member.label) : null;
  const value = safeParse(salary, token.decimals);
  const valid = isAddress(address) && address.toLowerCase() !== zeroAddress && address.toLowerCase() !== PAYROLL?.toLowerCase() && value !== null && value <= maxUint128 &&
    (editing || person.name.length > 0);

  const submit = async () => {
    if (!valid || value === null) return;
    const ok = editing
      ? await write({
          ...payroll,
          title: `Update ${current!.name}’s salary`,
          functionName: "setSalary",
          args: [org.id, member!.account, value],
        })
      : await write({
          ...payroll,
          title: `Add ${person.name}${person.role ? ` · ${person.role}` : ""}`,
          functionName: "addMember",
          args: [org.id, getAddress(address), value, formatLabel(person)],
        });
    if (ok) onClose();
  };

  const newTotal = org.totalSalary - (editing && member!.status === Status.Active ? member!.salary : 0n) +
    (!editing || member!.status === Status.Active ? value ?? 0n : 0n);
  const strong = { color: "var(--text)", fontWeight: 500 } as const;

  return (
    <Modal
      title={editing ? "Change salary" : member ? "Re-hire member" : "Add team member"}
      subtitle={
        editing
          ? `Applies from the next payday, ${fmtDate(org.nextPayday)}.`
          : `Paid in full on the ${ordinal(org.payDay)} of every month.`
      }
      onClose={onClose}
    >
      <div className="stack">
        {!editing ? (
          <>
            <div className="field">
              <label>Wallet address</label>
              <input
                className="input mono"
                placeholder="0x…"
                value={address}
                disabled={!!member}
                onChange={(e) => setAddress(e.target.value.trim())}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Name, role</label>
              <input
                className="input"
                placeholder="e.g. Sam Jay, Marketing"
                value={who}
                maxLength={60}
                onChange={(e) => setWho(e.target.value)}
              />
              <span className="hint">
                {person.name ? (
                  <>
                    Name <strong style={strong}>{person.name}</strong>
                    {person.role ? (
                      <>
                        {" "}
                        · Role <strong style={strong}>{person.role}</strong>
                      </>
                    ) : (
                      " · add a role after a comma"
                    )}
                  </>
                ) : (
                  "Separate name and role with a comma."
                )}
              </span>
            </div>
          </>
        ) : (
          <div className="row">
            <Avatar address={member!.account} />
            <div>
              <div>
                {current!.name || shortAddr(member!.account)}
                {current!.role && <span className="muted"> · {current!.role}</span>}
              </div>
              <div className="tiny faint mono">{shortAddr(member!.account)}</div>
            </div>
          </div>
        )}
        <div className="field">
          <label>Monthly salary</label>
          <AmountInput value={salary} onChange={setSalary} symbol={token.symbol} autoFocus={editing} />
          {value !== null && value > maxUint128 && <Bad>Salary exceeds the supported maximum.</Bad>}
          <span className="hint num">
            {value !== null && value > 0n
              ? `Monthly payroll becomes ${fmt(newTotal, token.decimals, 2)} ${token.symbol}.`
              : "Leave at 0 for a bonus-only contractor."}
          </span>
        </div>
        {!editing && !member && (
          <div className="banner info">
            <ShieldCheck size={16} />
            <span>
              They’ll confirm this wallet from the Employee tab before their first payout. Until then their salary is
              held safely in the treasury.
            </span>
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !valid} onClick={submit}>
          {editing ? "Update salary" : "Add to payroll"}
        </button>
      </div>
    </Modal>
  );
}

export function BulkImportModal({ org, token, onClose }: { org: OrgView; token: TokenMeta; onClose: () => void }) {
  const { write, busy } = useTx();
  const [text, setText] = useState("");

  const rows = useMemo(() => parseBulkMembers(text, token.decimals, PAYROLL), [text, token.decimals]);

  const good = rows.filter((r) => !r.error);
  const added = good.reduce((s, r) => s + (r.salary ?? 0n), 0n);

  const submit = async () => {
    const ok = await write({
      ...payroll,
      title: `Onboard ${good.length} people`,
      functionName: "addMembers",
      args: [org.id, good.map((r) => getAddress(r.address)), good.map((r) => r.salary!), good.map((r) => r.label)],
    });
    if (ok) onClose();
  };

  return (
    <Modal title="Bulk import" subtitle="One person per line: address, monthly salary, name, role." onClose={onClose} wide>
      <div className="stack">
        <textarea
          className="textarea"
          autoFocus
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`0x7a1c…1a3c, 5400, Maya Chen, Design\n0x3f9e…5f4e, 8200, Kenji, Protocol\n0xb4c8…c8e0, 4600, Ada Obi, Growth`}
        />
        {rows.length > 0 && (
          <div className="preview">
            {rows.map((r, i) => {
              const p = parseLabel(r.label);
              return (
                <div className="tr" key={i}>
                  <span className="mono">{isAddress(r.address) ? shortAddr(r.address) : r.address || "—"}</span>
                  <span>
                    {p.name || "—"}
                    {p.role && <span className="faint"> · {p.role}</span>}
                  </span>
                  <span className={r.error ? "bad" : "num"}>{r.error ?? `${r.monthly} ${token.symbol}/mo`}</span>
                </div>
              );
            })}
          </div>
        )}
        {good.length > 0 && (
          <div className="small muted">
            {good.length} valid {good.length === 1 ? "row" : "rows"} · adds {fmt(added, token.decimals, 2)} {token.symbol}{" "}
            to the monthly payroll
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || good.length === 0 || good.length !== rows.length}
          onClick={submit}
        >
          Onboard {good.length || ""}
        </button>
      </div>
    </Modal>
  );
}

export function RunPayrollModal({
  org,
  token,
  members,
  onClose,
  onFund,
}: {
  org: OrgView;
  token: TokenMeta;
  members: MemberView[];
  onClose: () => void;
  onFund: () => void;
}) {
  const { write, busy } = useTx();
  const payees = members.filter((m) => m.due > 0n && canBePaid(m));
  const held = members.filter((m) => m.due > 0n && !canBePaid(m));
  const total = payees.reduce((s, m) => s + m.due, 0n);
  const short = total > org.treasury ? total - org.treasury : 0n;
  const d = token.decimals;

  const submit = async () => {
    const ok = await write({ ...payroll, title: `Run payroll · ${payees.length} people`, functionName: "runPayroll", args: [org.id] });
    if (ok) onClose();
  };

  return (
    <Modal title="Run payroll" subtitle="Everyone below is paid in one transaction." onClose={onClose} wide>
      <div className="stack">
        <div className="preview" style={{ maxHeight: 280 }}>
          {payees.map((m) => (
            <div className="tr" key={m.account}>
              <span>{displayLabel(m.label, m.account)}</span>
              <span className="faint small">
                {m.splitBps > 0 ? `${m.splitBps / 100}% → ${shortAddr(m.splitTo)}` : shortAddr(m.account)}
              </span>
              <span className="num" style={{ textAlign: "right" }}>
                {fmt(m.due, d, 2)} {token.symbol}
              </span>
            </div>
          ))}
        </div>
        <div className="row">
          <span className="muted">Total</span>
          <span className="spacer" />
          <strong className="num">
            {fmt(total, d, 2)} {token.symbol}
          </strong>
        </div>
        {held.length > 0 && (
          <div className="banner info">
            <ShieldCheck size={16} />
            <span>
              Holding {fmt(held.reduce((s, m) => s + m.due, 0n), d, 2)} {token.symbol} for{" "}
              {held.map((m) => memberName(m.label, m.account)).join(", ")} until their wallet is confirmed or their
              wallet change completes. It stays reserved and is paid on a later run.
            </span>
          </div>
        )}
        {short > 0n && (
          <div className="banner">
            <TriangleAlert size={16} />
            <span style={{ flex: 1 }}>
              The treasury is {fmt(short, d, 2)} {token.symbol} short.
            </span>
            <button className="btn btn-sm" onClick={onFund}>
              Fund
            </button>
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || payees.length === 0 || short > 0n} onClick={submit}>
          Pay {payees.length} {payees.length === 1 ? "person" : "people"}
        </button>
      </div>
    </Modal>
  );
}

export function BonusModal({
  org,
  token,
  members,
  preselect,
  onClose,
}: {
  org: OrgView;
  token: TokenMeta;
  members: MemberView[];
  preselect?: Address;
  onClose: () => void;
}) {
  const { write, busy } = useTx();
  const eligible = members.filter((m) => (m.status === Status.Active || m.status === Status.Paused) && canBePaid(m));
  const [target, setTarget] = useState<string>(preselect ?? "all");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const value = safeParse(amount, token.decimals);
  const recipients = target === "all" ? eligible : eligible.filter((m) => m.account === target);
  const total = (value ?? 0n) * BigInt(recipients.length);
  const skipped = members.filter(
    (m) => (m.status === Status.Active || m.status === Status.Paused) && !canBePaid(m),
  ).length;

  const submit = async () => {
    if (!value) return;
    const title =
      recipients.length === 1
        ? `Bonus for ${memberName(recipients[0].label, recipients[0].account)}`
        : `Bonus round · ${recipients.length} people`;
    const ok =
      recipients.length === 1
        ? await write({ ...payroll, title, functionName: "payBonus", args: [org.id, recipients[0].account, value, memo.trim()] })
        : await write({
            ...payroll,
            title,
            functionName: "payBonuses",
            args: [org.id, recipients.map((r) => r.account), recipients.map(() => value), memo.trim()],
          });
    if (ok) onClose();
  };

  return (
    <Modal title="Send a bonus" subtitle="Paid instantly, straight to their wallet." onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label>Recipient</label>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="all">Everyone on the team ({eligible.length})</option>
            {eligible.map((m) => (
              <option key={m.account} value={m.account}>
                {displayLabel(m.label, m.account)} · {shortAddr(m.account)}
              </option>
            ))}
          </select>
          {skipped > 0 && (
            <span className="hint">
              {skipped} {skipped === 1 ? "person isn't" : "people aren't"} listed until their wallet is confirmed.
            </span>
          )}
        </div>
        <div className="field">
          <label>{target === "all" ? "Amount per person" : "Amount"}</label>
          <AmountInput value={amount} onChange={setAmount} symbol={token.symbol} autoFocus />
          <span className="hint num">
            Total {fmt(total, token.decimals)} {token.symbol} · surplus available {fmt(org.surplus, token.decimals)}{" "}
            {token.symbol}
          </span>
        </div>
        <div className="field">
          <label>Memo (on-chain)</label>
          <input
            className="input"
            placeholder="e.g. Shipped mainnet 🚀"
            value={memo}
            maxLength={80}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
        {total > org.surplus && (
          <div className="banner">Bonuses come from surplus, never from reserved salaries. Fund the treasury first.</div>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !value || recipients.length === 0 || total > org.surplus}
          onClick={submit}
        >
          Send bonus
        </button>
      </div>
    </Modal>
  );
}

export function ChangeWalletModal({
  orgId,
  account,
  name,
  byEmployer,
  onClose,
}: {
  orgId: bigint;
  account: Address;
  name: string;
  byEmployer: boolean;
  onClose: () => void;
}) {
  const { write, busy } = useTx();
  const [to, setTo] = useState("");
  const valid = isAddress(to) && to.toLowerCase() !== zeroAddress && to.toLowerCase() !== account.toLowerCase() && to.toLowerCase() !== PAYROLL?.toLowerCase();

  const submit = async () => {
    const ok = await write({
      ...payroll,
      title: "Request wallet change",
      functionName: "requestWalletChange",
      args: [orgId, account, getAddress(to)],
    });
    if (ok) onClose();
  };

  return (
    <Modal
      title="Change payout wallet"
      subtitle={byEmployer ? `For ${name}, e.g. if they lost access to their wallet.` : "Move your salary to a different wallet."}
      onClose={onClose}
    >
      <div className="stack">
        <div className="field">
          <label>New wallet</label>
          <input className="input mono" placeholder="0x…" value={to} autoFocus onChange={(e) => setTo(e.target.value.trim())} />
        </div>
        <div className="banner info">
          <ShieldCheck size={16} />
          <span>
            For safety this takes 48 hours. Until then, payouts are held, and both {byEmployer ? `${name}’s current wallet` : "you"} and
            the employer can block the change. Afterwards the new wallet accepts it from the Employee tab, which proves
            it’s the right address.
          </span>
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !valid} onClick={submit}>
          Start 48h change
        </button>
      </div>
    </Modal>
  );
}

export function TransferModal({ org, onClose, onDone }: { org: OrgView; onClose: () => void; onDone: () => void }) {
  const { write, busy } = useTx();
  const [to, setTo] = useState("");
  const submit = async () => {
    const ok = await write({
      ...payroll,
      title: "Transfer ownership",
      functionName: "transferOrgOwnership",
      args: [org.id, getAddress(to)],
    });
    if (ok) {
      onDone();
      onClose();
    }
  };
  return (
    <Modal
      title="Transfer ownership"
      subtitle="Hand this payroll to a multisig or another admin. You can’t undo this yourself."
      onClose={onClose}
    >
      <div className="field">
        <label>New owner</label>
        <input className="input mono" placeholder="0x…" value={to} autoFocus onChange={(e) => setTo(e.target.value.trim())} />
      </div>
      <div className="actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !isAddress(to) || to.toLowerCase() === zeroAddress || to.toLowerCase() === PAYROLL?.toLowerCase()} onClick={submit}>
          Transfer
        </button>
      </div>
    </Modal>
  );
}
