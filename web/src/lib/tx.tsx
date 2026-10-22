import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import { FAUCET_URL, publicClient } from "./chain";
import { useWallet } from "./wallet";
import { assertWalletAccount, waitForConfirmedTransaction } from "./transactions";

export type Toast = {
  id: number;
  kind: "pending" | "success" | "error" | "info";
  title: string;
  body?: string;
  hash?: Hash;
  link?: { href: string; label: string };
};

class NeedsGasError extends Error {}

const NO_GAS = "This wallet has no zkLTC to pay gas. Grab free testnet zkLTC from the faucet, then try again.";
/** Gas assumed for the balance pre-check when the RPC can't estimate. Larger payrolls use their actual estimate. */
const FALLBACK_GAS = 500_000n;

/** Wallets surface "insufficient funds" in many shapes, often not as a viem error, so search the whole chain. */
function mentionsInsufficientFunds(err: unknown): boolean {
  const seen = new Set<unknown>();
  let e: any = err;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const text = [e.message, e.shortMessage, e.details, e.data?.message].filter(Boolean).join(" ");
    if (/insufficient funds|exceeds the balance/i.test(text)) return true;
    e = e.cause ?? e.data?.originalError ?? e.error;
  }
  return typeof err === "string" && /insufficient funds/i.test(err);
}

const FRIENDLY: Record<string, string> = {
  NotOrgOwner: "Only the payroll owner can do that.",
  UnknownOrg: "That payroll doesn't exist.",
  InvalidAddress: "That address isn't valid.",
  InvalidAmount: "Enter an amount greater than zero.",
  InvalidSplit: "Split must be 0–100% with a destination address.",
  InvalidPayday: "Pick a payday between the 1st and the 28th.",
  EmptyName: "Give the payroll a name.",
  LengthMismatch: "Bulk import rows are malformed.",
  TooManyMembers: "This payroll has reached the 250 member limit.",
  AlreadyMember: "That address is already on this payroll.",
  NotMember: "That address isn't on this payroll.",
  InvalidStatus: "That action isn't available for this member's current status.",
  InsufficientSurplus: "Not enough surplus. Owed salaries and the next payroll are reserved and can't be used.",
  InsufficientTreasury: "The treasury can't cover this payroll yet. Fund it, then run payroll again.",
  NothingDue: "Nothing is due yet. Salaries become payable on payday.",
  TransferFailed: "The transfer was rejected by the receiving address.",
  NotAuthorized: "Only the employee or the payroll owner can do that.",
  AlreadyConfirmed: "This wallet is already confirmed.",
  WalletNotConfirmed: "They haven't confirmed their wallet yet, so nothing can be sent to it.",
  WalletChangePending: "Their payout wallet is being changed. Payouts resume once that's settled.",
  NoWalletChange: "There's no pending wallet change for this wallet.",
  WalletChangeNotReady: "The 48-hour safety window hasn't passed yet.",
  DripCooldown: "Faucet cooldown: you can drip LitUSD once an hour.",
};

export function explainError(err: unknown): string {
  if (err instanceof NeedsGasError) return err.message;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Request rejected in wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name) return FRIENDLY[name] ?? name;
      if (revert.reason) return revert.reason;
    }
  }
  if (mentionsInsufficientFunds(err)) return NO_GAS;
  if (/max fee per gas less than block base fee/i.test(String((err as any)?.message ?? err)))
    return "The network fee rose while you were signing. Nothing was sent; please try again.";
  if (err instanceof BaseError) return err.shortMessage;
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return "Request rejected in wallet.";
  return e?.message ?? String(err);
}

export type WriteArgs = {
  title: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

type TxCtx = {
  toasts: Toast[];
  dismiss: (id: number) => void;
  notify: (t: Omit<Toast, "id">) => void;
  write: (w: WriteArgs) => Promise<boolean>;
  busy: boolean;
  /** Bumped after every confirmed transaction so data hooks refetch. */
  version: number;
};

const Ctx = createContext<TxCtx | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const { walletClient, account, ensureLitvm } = useWallet();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const nextId = useRef(1);
  const inFlight = useRef(false);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: Omit<Toast, "id">, id = nextId.current++) => {
      setToasts((ts) => [...ts.filter((x) => x.id !== id), { ...t, id }].slice(-4));
      if (t.kind !== "pending") setTimeout(() => dismiss(id), t.kind === "error" ? (t.link ? 20000 : 9000) : 6000);
      return id;
    },
    [dismiss],
  );

  const notify = useCallback((t: Omit<Toast, "id">) => void push(t), [push]);

  const write = useCallback(
    async ({ title, address, abi, functionName, args, value }: WriteArgs) => {
      if (!walletClient || !account) {
        push({ kind: "error", title: "Wallet not connected", body: "Connect a wallet to continue." });
        return false;
      }
      if (inFlight.current) return false;
      inFlight.current = true;
      const id = nextId.current++;
      let hash: Hash | undefined;
      setBusy(true);
      try {
        await ensureLitvm();
        const call = { account, address, abi, functionName, args, value } as any;
        const { request } = await publicClient.simulateContract(call);
        // Set fees explicitly to cover LiteForge base-fee changes while the wallet signs.
        const [balance, gasEstimate, fees] = await Promise.all([
          publicClient.getBalance({ address: account }),
          // A successful simulation permits falling back to the wallet's gas estimate.
          publicClient.estimateContractGas(call).catch(() => undefined),
          publicClient.estimateFeesPerGas(),
        ]);
        const gas = gasEstimate === undefined ? undefined : (gasEstimate * 12n) / 10n;
        const fee = (gas ?? FALLBACK_GAS) * fees.maxFeePerGas;
        if (balance < fee + (value ?? 0n)) {
          throw new NeedsGasError(
            balance >= fee && value
              ? "Not enough zkLTC to cover this amount plus gas. Lower the amount or top up from the faucet."
              : NO_GAS,
          );
        }
        await assertWalletAccount(walletClient, account);
        push({ kind: "pending", title, body: "Confirm in your wallet…" }, id);
        hash = await walletClient.writeContract({
          ...(request as any),
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        push({ kind: "pending", title, body: "Waiting for LitVM to confirm…", hash }, id);
        const receipt = await waitForConfirmedTransaction(publicClient, hash, (replacementHash) => {
          hash = replacementHash;
          push({ kind: "pending", title, body: "Waiting for LitVM to confirm…", hash }, id);
        });
        hash = receipt.transactionHash;
        push({ kind: "success", title, body: "Confirmed on LitVM", hash }, id);
        setVersion((v) => v + 1);
        return true;
      } catch (err) {
        const gasProblem = err instanceof NeedsGasError || mentionsInsufficientFunds(err);
        push(
          {
            kind: "error",
            title,
            body: explainError(err),
            hash,
            link: gasProblem ? { href: FAUCET_URL, label: "Get testnet zkLTC" } : undefined,
          },
          id,
        );
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [walletClient, account, ensureLitvm, push],
  );

  return <Ctx.Provider value={{ toasts, dismiss, notify, write, busy, version }}>{children}</Ctx.Provider>;
}

export function useTx() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTx must be used inside TxProvider");
  return ctx;
}

