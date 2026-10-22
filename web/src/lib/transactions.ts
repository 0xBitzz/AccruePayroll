import type { Address, Hash, PublicClient, WalletClient } from "viem";

/** Recheck after network switching and simulation, which may take long enough for the account to change. */
export async function assertWalletAccount(client: Pick<WalletClient, "getAddresses">, account: Address) {
  const accounts = await client.getAddresses();
  if (accounts[0]?.toLowerCase() !== account.toLowerCase())
    throw new Error("The connected account changed. Review the action and try again.");
}

/** A successful cancellation receipt does not confirm the original contract call. */
export async function waitForConfirmedTransaction(
  client: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: Hash,
  onHash: (hash: Hash) => void,
) {
  let replacement: "cancelled" | "replaced" | undefined;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    pollingInterval: 1_000,
    onReplaced: ({ reason, transactionReceipt }) => {
      if (reason !== "repriced") replacement = reason;
      onHash(transactionReceipt.transactionHash);
    },
  });
  if (replacement === "cancelled") throw new Error("Transaction cancelled in your wallet.");
  if (replacement === "replaced") throw new Error("A different transaction replaced this action. Review it before trying again.");
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
  return receipt;
}
