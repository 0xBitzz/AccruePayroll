import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { publicClient } from "./chain";
import { deployment, lusdAbi, payrollAbi } from "./generated";
import { useTx } from "./tx";

export const PAYROLL = deployment.payroll;
export const LUSD = deployment.lusd;
export const isDeployed = !!PAYROLL;

export enum Status {
  None = 0,
  Active = 1,
  Paused = 2,
  Terminated = 3,
}

export type OrgView = {
  id: bigint;
  owner: Address;
  token: Address;
  name: string;
  payDay: number;
  createdAt: bigint;
  treasury: bigint;
  totalSalary: bigint; // monthly payroll of active members
  due: bigint; // owed for paydays that have passed
  payable_: bigint; // the part of `due` runPayroll would send now
  held: bigint; // the part of `due` held for unconfirmed wallets / pending wallet changes
  reserved: bigint; // due + next payroll
  surplus: bigint;
  shortfall: bigint;
  nextPayday: bigint;
  lastPayday: bigint;
  totalPaid: bigint;
  headcount: bigint;
  unconfirmed: bigint;
  pendingChanges: bigint;
  timestamp: bigint;
};

export type MemberView = {
  account: Address;
  status: Status;
  label: string;
  salary: bigint;
  due: bigint;
  totalPaid: bigint;
  splitTo: Address;
  splitBps: number;
  confirmed: boolean;
  pendingWallet: Address;
  changeReadyAt: bigint;
};

export type MembershipView = {
  orgId: bigint;
  orgName: string;
  orgOwner: Address;
  token: Address;
  payDay: number;
  nextPayday: bigint;
  funded: boolean;
  member: MemberView;
  timestamp: bigint;
};

export const hasPendingChange = (m: MemberView) => m.pendingWallet !== zeroAddress;
/** Salaries only go to confirmed wallets that aren't mid-change (mirrors the contract's `_canPay`). */
export const canBePaid = (m: MemberView) => m.confirmed && !hasPendingChange(m);

export type TokenMeta = { address: Address; symbol: string; decimals: number; native: boolean };

/** Fetches on mount, on deps change, after every confirmed tx and every `interval` ms.
 *  `fetchedAt` (local ms) lets countdowns run from the snapshot. */
export function usePoll<T>(fn: (() => Promise<T>) | null, deps: unknown[], interval = 12_000) {
  const { version } = useTx();
  const scope = useMemo(() => ({}), [...deps, !!fn]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  type Snapshot = { data?: T; error?: unknown; fetchedAt: number; loading: boolean; scope: object };
  const [state, setState] = useState<Snapshot>({
    scope,
    fetchedAt: 0,
    loading: !!fn,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const generation = useRef(0);
  const requestId = useRef(0);
  const inFlight = useRef<{ scope: object; generation: number; id: number }>();

  const load = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    const currentGeneration = generation.current;
    const currentScope = scopeRef.current;
    if (inFlight.current?.scope === currentScope && inFlight.current.generation === currentGeneration) return;
    const currentRequest = ++requestId.current;
    inFlight.current = { scope: currentScope, generation: currentGeneration, id: currentRequest };
    try {
      const data = await f();
      if (generation.current !== currentGeneration || requestId.current !== currentRequest || scopeRef.current !== currentScope) return;
      setState({ scope: currentScope, data, fetchedAt: Date.now(), loading: false });
    } catch (error) {
      if (generation.current !== currentGeneration || requestId.current !== currentRequest || scopeRef.current !== currentScope) return;
      setState((s) => ({
        ...(s.scope === currentScope ? s : { scope: currentScope, fetchedAt: 0 }), error, loading: false,
      }));
    } finally {
      if (inFlight.current?.id === currentRequest) inFlight.current = undefined;
    }
  }, []);

  useEffect(() => {
    ++generation.current;
    if (!fn) {
      setState({ scope, fetchedAt: 0, loading: false });
      return () => { ++generation.current; };
    }
    setState((s) => s.scope === scope ? { ...s, loading: s.data === undefined } : { scope, fetchedAt: 0, loading: true });
    load();
    const t = setInterval(load, interval);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      ++generation.current;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [...deps, version, !!fn]);

  const visible: Snapshot = state.scope === scope ? state : { scope, fetchedAt: 0, loading: !!fn };
  return { ...visible, reload: load };
}

const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
  publicClient.readContract({ address: PAYROLL!, abi: payrollAbi, functionName, args } as any) as Promise<T>;

export async function fetchOwnedOrgs(owner: Address): Promise<OrgView[]> {
  const ids = await read<bigint[]>("orgsOwnedBy", [owner]);
  return Promise.all(ids.map((id) => read<OrgView>("getOrg", [id])));
}

export const fetchOrg = (id: bigint) => read<OrgView>("getOrg", [id]);
export const fetchRoster = (id: bigint) => read<MemberView[]>("getRoster", [id]);
export const fetchMemberships = (account: Address) => read<MembershipView[]>("getMemberships", [account]);

const tokenCache = new Map<string, Promise<TokenMeta>>();

export function tokenMeta(address: Address): Promise<TokenMeta> {
  const key = address.toLowerCase();
  if (!tokenCache.has(key)) {
    const p = (async (): Promise<TokenMeta> => {
      if (address === zeroAddress) return { address, symbol: "zkLTC", decimals: 18, native: true };
      const [symbol, decimals] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { address, symbol, decimals, native: false };
    })();
    p.catch(() => tokenCache.delete(key));
    tokenCache.set(key, p);
  }
  return tokenCache.get(key)!;
}

export function useToken(address?: Address) {
  const [state, setState] = useState<{ meta?: TokenMeta; error?: unknown }>({});
  useEffect(() => {
    setState({});
    if (!address) return;
    let live = true;
    tokenMeta(address)
      .then((meta) => live && setState({ meta }))
      .catch((error: unknown) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [address]);
  const meta = state.meta?.address.toLowerCase() === address?.toLowerCase() ? state.meta : undefined;
  return { meta, error: state.error };
}

export async function balanceOf(token: TokenMeta, account: Address): Promise<bigint> {
  if (token.native) return publicClient.getBalance({ address: account });
  return publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

export async function allowance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, PAYROLL!] });
}

export async function lusdReadyAt(account: Address): Promise<number> {
  if (!LUSD) return 0;
  const last = await publicClient.readContract({ address: LUSD, abi: lusdAbi, functionName: "lastDrip", args: [account] });
  return last === 0n ? 0 : Number(last) + 3600;
}

// Activity and payslips are stored in the contract and read with a single call each. LitVM's public RPC can be
// very slow to serve eth_getLogs and the explorer doesn't index logs reliably, so the app doesn't depend on either.

export enum Action {
  Created,
  Deposited,
  Withdrew,
  Added,
  SalaryChanged,
  Paused,
  Resumed,
  Removed,
  PayrollRun,
  PaymentFailed,
  Bonus,
  WalletConfirmed,
  WalletChangeRequested,
  WalletChangeCancelled,
  WalletChanged,
  OwnershipTransferred,
}

export type Entry = {
  index: number;
  at: number;
  action: Action;
  who: Address;
  amount: bigint;
  extra: bigint;
  other: Address;
  memo: string;
};

export async function fetchActivity(orgId: bigint, limit = 50): Promise<{ entries: Entry[]; total: number }> {
  const [raw, memos, total] = await read<[any[], string[], bigint]>("getActivity", [orgId, 0n, BigInt(limit)]);
  const t = Number(total);
  return {
    total: t,
    entries: raw.map((e, i) => ({
      index: t - 1 - i,
      at: Number(e.at),
      action: Number(e.action) as Action,
      who: e.who,
      amount: e.amount,
      extra: e.extra,
      other: e.other,
      memo: memos[i],
    })),
  };
}

export type Payslip = {
  orgId: bigint;
  at: number;
  bonus: boolean;
  amount: bigint;
  splitAmount: bigint;
  memo: string;
};

/** Payslips across every payroll `account` is on, newest first. */
export async function fetchPayslips(account: Address, orgIds: bigint[], limit = 60): Promise<Payslip[]> {
  const lists = await Promise.all(
    orgIds.map((orgId) =>
      read<any[]>("getPayslips", [orgId, account, BigInt(limit)]).then((list) =>
        list.map((p) => ({
          orgId,
          at: Number(p.at),
          bonus: p.bonus,
          amount: p.amount,
          splitAmount: p.splitAmount,
          memo: p.memo,
        })),
      ),
    ),
  );
  return lists.flat().sort((a, b) => b.at - a.at);
}

export type IncomingChange = { orgId: bigint; orgName: string; from: Address; readyAt: number; chainNow: number };

/** Wallet changes pointing at `wallet` that it can accept once their 48h window passes. */
export async function fetchIncomingChanges(wallet: Address): Promise<IncomingChange[]> {
  const [list, block] = await Promise.all([read<any[]>("incomingWalletChanges", [wallet]), publicClient.getBlock()]);
  return list.map((c) => ({
    orgId: c.orgId,
    orgName: c.orgName,
    from: c.from,
    readyAt: Number(c.readyAt),
    chainNow: Number(block.timestamp),
  }));
}
