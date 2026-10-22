#!/usr/bin/env bash
# Deploy AccruePayroll to LitVM LiteForge using contracts/.env or the shell environment.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi
: "${PRIVATE_KEY:?Configure PRIVATE_KEY in contracts/.env or the shell.}"
: "${LITVM_RPC_URL:=https://liteforge.rpc.caldera.xyz/http}"
: "${SEED_DEMO:=1}"
export PRIVATE_KEY LITVM_RPC_URL SEED_DEMO
[[ -z "${LUSD:-}" ]] || export LUSD
export CHAIN_ID=4441

for task_tool in forge node npm; do
  command -v "$task_tool" >/dev/null || { echo "Missing required tool: $task_tool" >&2; exit 1; }
done

if [[ "$SEED_DEMO" != 0 ]]; then
  for demo_key in DEMO_MAYA_PRIVATE_KEY DEMO_KENJI_PRIVATE_KEY DEMO_ADA_PRIVATE_KEY; do
    if [[ -z "${!demo_key:-}" ]]; then
      echo "Configure $demo_key in contracts/.env, or set SEED_DEMO=0." >&2
      exit 1
    fi
    export "$demo_key"
  done
fi

DEPLOYER=$(node --input-type=module -e '
  import { privateKeyToAccount } from "../web/node_modules/viem/_esm/accounts/index.js";
  function signer(name) {
    const value = process.env[name];
    if (/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) {
      try { return privateKeyToAccount(value); } catch {}
    }
    throw new Error(`Configure a valid ${name} in contracts/.env or the shell.`);
  }
  try {
    const deployer = signer("PRIVATE_KEY");
    const addresses = new Set([deployer.address]);
    if (process.env.SEED_DEMO !== "0") {
      for (const name of ["DEMO_MAYA_PRIVATE_KEY", "DEMO_KENJI_PRIVATE_KEY", "DEMO_ADA_PRIVATE_KEY"]) {
        const account = signer(name);
        if (addresses.has(account.address)) throw new Error("Demo wallets must be distinct from each other and the deployer.");
        addresses.add(account.address);
      }
    }
    console.log(deployer.address);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
')

CHAIN=$(node ../scripts/litvm-rpc.mjs chain-id)
if [[ "$CHAIN" != 4441 ]]; then
  echo "Expected LitVM LiteForge chain 4441; RPC reports $CHAIN." >&2
  exit 1
fi
node --input-type=module -e '
  const url = new URL(process.env.LITVM_RPC_URL);
  if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) {
    throw new Error("Use the local deployment instructions for anvil. This script deploys to LitVM testnet.");
  }
'

EXPLORER_API="https://liteforge.explorer.caldera.xyz/api/"
BALANCE=$(node ../scripts/litvm-rpc.mjs balance "$DEPLOYER")
[[ "$BALANCE" != 0 ]] || { echo "Fund $DEPLOYER with testnet zkLTC before deploying." >&2; exit 1; }
echo "Deployer: $DEPLOYER ($BALANCE wei of zkLTC)"
if [[ -n "${LUSD:-}" ]]; then
  TOKEN_CODE=$(node ../scripts/litvm-rpc.mjs code "$LUSD")
  if [[ "$TOKEN_CODE" == 0x ]]; then
    echo "LUSD must point to an existing LitUSD contract." >&2
    exit 1
  fi
fi

# Check the exact sources being deployed. JSON mode also works around old Foundry's macOS trace crash.
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/AccruePayroll-deploy-checks.XXXXXX")
trap 'rm -rf "$CHECK_DIR"' EXIT
if ! forge test --json > "$CHECK_DIR/contracts.json"; then
  echo "Contract tests failed; details: $CHECK_DIR/contracts.json" >&2
  trap - EXIT
  exit 1
fi
node --input-type=module - "$CHECK_DIR/contracts.json" <<'JS'
  import { readFileSync } from "node:fs";
  const suites = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const results = Object.values(suites).flatMap((suite) => Object.entries(suite.test_results ?? {}));
  const failed = results.filter(([, result]) => result.status !== "Success");
  if (!results.length || failed.length) throw new Error("Contract tests did not all pass.");
  console.log(`Contract tests: ${results.length} passed.`);
JS
npm --prefix ../web test
npm --prefix ../web run build

# Keep each attempt in its own directory so failures and local runs cannot erase a live record.
mkdir -p broadcast
RUN_DIR=$(mktemp -d "$PWD/broadcast/litvm-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
export FOUNDRY_BROADCAST="$RUN_DIR"
GAS_PRICE=$(node ../scripts/litvm-rpc.mjs gas-price)
MAX_FEE=$(node -e 'console.log((BigInt(process.argv[1]) * 2n).toString())' "$GAS_PRICE")
forge script script/Deploy.s.sol --rpc-url "$LITVM_RPC_URL" --broadcast --slow --json --with-gas-price "$MAX_FEE"
export BROADCAST_FILE="$RUN_DIR/Deploy.s.sol/4441/run-latest.json"

PAYROLL=$(node -e 'console.log(require(process.env.BROADCAST_FILE).returns.payroll.value)')
LUSD=$(node -e 'console.log(require(process.env.BROADCAST_FILE).returns.lusd.value)')
export PAYROLL LUSD
for task_address in "$PAYROLL" "$LUSD"; do
  CODE=$(node ../scripts/litvm-rpc.mjs code "$task_address")
  [[ "$CODE" != 0x ]] || {
    echo "No deployed bytecode at $task_address; web addresses were not changed." >&2
    exit 1
  }
done
node ../scripts/sync-contracts.mjs
npm --prefix ../web run build
mkdir -p broadcast/Deploy.s.sol/4441
cp "$BROADCAST_FILE" broadcast/Deploy.s.sol/4441/run-latest.json

for pair in "$PAYROLL:src/AccruePayroll.sol:AccruePayroll" "$LUSD:src/LitUSD.sol:LitUSD"; do
  addr=${pair%%:*}
  target=${pair#*:}
  forge verify-contract "$addr" "$target" --chain-id 4441 --verifier blockscout --verifier-url "$EXPLORER_API" --watch \
    || echo "Verification of $target is pending; rerun after explorer indexing."
done

if [[ "${SEED_DEMO:-1}" != 0 ]]; then
  GAS_PRICE=$(node ../scripts/litvm-rpc.mjs gas-price)
  MAX_FEE=$(node -e 'console.log((BigInt(process.argv[1]) * 2n).toString())' "$GAS_PRICE")
  PAYROLL=$PAYROLL LUSD=$LUSD forge script script/Seed.s.sol --rpc-url "$LITVM_RPC_URL" --broadcast --slow --json --with-gas-price "$MAX_FEE" \
    || echo "Contracts deployed, but demo setup did not complete. Resume using records in $RUN_DIR."
fi

printf '\nAccruePayroll  %s\nLitUSD         %s\nDeployment     %s\nWeb build      %s\n' \
  "$PAYROLL" "$LUSD" "$BROADCAST_FILE" "$(cd ../web/dist && pwd)"
