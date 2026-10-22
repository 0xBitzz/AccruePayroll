import { createPublicClient, defineChain, http } from "viem";

const LITVM_RPC = "https://liteforge.rpc.caldera.xyz/http";
// VITE_RPC_URL lets the app run against a local anvil node (`anvil --chain-id 4441`) during development.
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || LITVM_RPC;
export const EXPLORER_URL = "https://liteforge.explorer.caldera.xyz";
export const FAUCET_URL = "https://testnet.litvm.com";

export const litvm = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: { default: { name: "LiteForge Explorer", url: EXPLORER_URL } },
  // The LiteForge base fee drifts between blocks; wallets that sign at exactly the current base fee get rejected.
  // Headroom costs nothing on Arbitrum Orbit: you're only charged the actual base fee.
  fees: { baseFeeMultiplier: 2 },
  testnet: true,
});

// Reads always go through the public RPC so the app works before a wallet is connected or while on the wrong chain.
export const publicClient = createPublicClient({ chain: litvm, transport: http(RPC_URL, { batch: true }) });

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
