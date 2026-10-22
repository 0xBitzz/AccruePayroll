import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, getAddress, type Address, type WalletClient } from "viem";
import { litvm } from "./chain";
import { readWalletState, switchOrAdd, walletError, type Provider } from "./wallet-rpc";
import { readPreference, savePreference } from "./storage";

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string; provider: Provider };

declare global {
  interface Window {
    ethereum?: Provider;
  }
}

type WalletCtx = {
  account?: Address;
  chainId?: number;
  wrongNetwork: boolean;
  connecting: boolean;
  error?: string;
  wallets: WalletInfo[];
  hasWallet: boolean;
  connect: (wallet?: WalletInfo) => Promise<void>;
  disconnect: () => void;
  ensureLitvm: () => Promise<void>;
  walletClient?: WalletClient;
};

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [provider, setProvider] = useState<Provider>();
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const autoTried = useRef(false);
  const session = useRef(0);
  const connectInFlight = useRef(false);

  // EIP-6963 discovers injected wallets without relying on window.ethereum.
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as CustomEvent).detail ?? {};
      if (!info || typeof info.uuid !== "string" || typeof info.name !== "string" ||
        typeof info.icon !== "string" || typeof info.rdns !== "string" || typeof provider?.request !== "function") return;
      setWallets((ws) => (ws.some((w) => w.uuid === info.uuid) ? ws : [...ws, { ...info, provider }]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const attach = useCallback(async (p: Provider, request: boolean, ticket: number) => {
    const state = await readWalletState(p, request);
    if (session.current !== ticket) return null;
    if (!state.account) {
      if (request) throw new Error("Unlock your wallet and select an account to connect.");
      return null;
    }
    setProvider(p);
    setAccount(state.account);
    setChainId(state.chainId);
    return state.chainId;
  }, []);

  const connect = useCallback(
    async (wallet?: WalletInfo) => {
      if (connectInFlight.current) return;
      const p = wallet?.provider ?? wallets[0]?.provider ?? window.ethereum;
      if (!p) {
        window.open("https://metamask.io/download/", "_blank", "noopener");
        return;
      }
      connectInFlight.current = true;
      autoTried.current = true;
      const ticket = ++session.current;
      setError(undefined);
      setConnecting(true);
      try {
        const cid = await attach(p, true, ticket);
        if (cid !== null) {
          savePreference("wallet", wallet?.rdns ?? wallets[0]?.rdns ?? "injected");
          if (cid !== litvm.id) {
            const actual = await switchOrAdd(p);
            if (session.current === ticket) setChainId(actual);
          }
        }
      } catch (error) {
        if (session.current === ticket) setError(walletError(error));
      } finally {
        connectInFlight.current = false;
        setConnecting(false);
      }
    },
    [wallets, attach],
  );

  useEffect(() => {
    if (autoTried.current) return;
    const saved = readPreference("wallet");
    if (!saved) return;
    const match = wallets.find((w) => w.rdns === saved);
    const p = match?.provider ?? (saved === "injected" ? window.ethereum : undefined);
    if (!p) {
      // Give EIP-6963 announcements a moment before giving up.
      const t = setTimeout(() => {
        const fallback = saved === "injected" ? window.ethereum : undefined;
        if (!autoTried.current && fallback) {
          autoTried.current = true;
          attach(fallback, false, ++session.current).catch(() => {});
        }
      }, 400);
      return () => clearTimeout(t);
    }
    autoTried.current = true;
    attach(p, false, ++session.current).catch(() => {});
  }, [wallets, attach]);

  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (accs: string[]) => {
      ++session.current;
      setAccount(accs[0] ? getAddress(accs[0]) : undefined);
      setError(undefined);
    };
    const onChain = (cid: string) => {
      setChainId(Number(cid));
      setError(undefined);
    };
    const onDisconnect = () => {
      ++session.current;
      setAccount(undefined);
      setChainId(undefined);
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider]);

  const disconnect = useCallback(() => {
    ++session.current;
    provider
      ?.request({ method: "wallet_revokePermissions" as any, params: [{ eth_accounts: {} }] as any })
      .catch(() => {});
    savePreference("wallet", null);
    autoTried.current = true;
    setAccount(undefined);
    setProvider(undefined);
    setChainId(undefined);
    setError(undefined);
  }, [provider]);

  const ensureLitvm = useCallback(async () => {
    if (!provider) throw new Error("Connect a wallet first");
    const ticket = session.current;
    try {
      const cid = Number(await provider.request({ method: "eth_chainId" }));
      const actual = cid !== litvm.id ? await switchOrAdd(provider) : cid;
      if (session.current !== ticket) throw new Error("The connected account changed. Try again.");
      setChainId(actual);
      setError(undefined);
    } catch (error) {
      if (session.current === ticket) setError(walletError(error));
      throw error;
    }
  }, [provider]);

  const walletClient = useMemo(
    () => (provider && account ? createWalletClient({ account, chain: litvm, transport: custom(provider) }) : undefined),
    [provider, account],
  );

  const value: WalletCtx = {
    account,
    chainId,
    wrongNetwork: !!account && chainId !== litvm.id,
    connecting,
    error,
    wallets,
    hasWallet: wallets.length > 0 || typeof window.ethereum !== "undefined",
    connect,
    disconnect,
    ensureLitvm,
    walletClient,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
