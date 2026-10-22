import { getAddress, type Address, type EIP1193Provider } from "viem";
import { EXPLORER_URL, RPC_URL, litvm } from "./chain";

export type Provider = EIP1193Provider & {
  on?: (event: string, cb: (...args: any[]) => void) => void;
  removeListener?: (event: string, cb: (...args: any[]) => void) => void;
};

export async function readWalletState(provider: Provider, request: boolean): Promise<{ account?: Address; chainId: number }> {
  const accounts = await provider.request({ method: request ? "eth_requestAccounts" : "eth_accounts" });
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  if (!Array.isArray(accounts) || !Number.isSafeInteger(chainId) || chainId < 1)
    throw new Error("The wallet returned invalid account or network details.");
  return { account: accounts[0] ? getAddress(accounts[0]) : undefined, chainId };
}

export async function switchOrAdd(provider: Provider): Promise<number> {
  const chainId = `0x${litvm.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err: any) {
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(err?.message))) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: litvm.name,
        nativeCurrency: litvm.nativeCurrency,
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER_URL],
      }],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
  const actual = Number(await provider.request({ method: "eth_chainId" }));
  if (actual !== litvm.id) throw new Error("Switch your wallet to LitVM to continue.");
  return actual;
}

export function walletError(error: unknown): string {
  const e = error as { code?: number; message?: string };
  if (e?.code === 4001) return "Request rejected in wallet.";
  if (e?.code === -32002) return "A wallet request is already open. Finish it in your wallet.";
  return e?.message ?? "Couldn’t connect to your wallet. Try again.";
}
