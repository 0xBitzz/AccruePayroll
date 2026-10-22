// Small JSON-RPC client that avoids old cast's macOS system-proxy crash.
const rpcUrl = process.env.LITVM_RPC_URL ?? "https://liteforge.rpc.caldera.xyz/http";
const [operation, address] = process.argv.slice(2);
const calls = {
  "chain-id": ["eth_chainId", []],
  balance: ["eth_getBalance", [address, "latest"]],
  code: ["eth_getCode", [address, "latest"]],
  "gas-price": ["eth_gasPrice", []],
};

try {
  const call = calls[operation];
  if (!call) throw new Error("Usage: litvm-rpc.mjs chain-id|balance ADDRESS|code ADDRESS|gas-price");
  if ((operation === "balance" || operation === "code") && !/^0x[0-9a-fA-F]{40}$/.test(address ?? ""))
    throw new Error("Provide a valid wallet or contract address.");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call[0], params: call[1] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.error) throw new Error(result.error.message ?? "RPC request failed.");
  if (typeof result.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result.result))
    throw new Error("RPC returned an invalid result.");
  console.log(operation === "code" ? result.result : BigInt(result.result).toString());
} catch (error) {
  console.error(`LitVM RPC unavailable: ${error.cause?.code ?? error.message}`);
  process.exitCode = 1;
}
