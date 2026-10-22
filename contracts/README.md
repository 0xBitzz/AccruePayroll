# AccruePayroll contracts

Foundry project for AccruePayroll on LitVM LiteForge testnet (chain 4441).

`src/AccruePayroll.sol` manages payroll treasuries, monthly salaries, bonuses, verified payout wallets and payslips.
`src/Calendar.sol` calculates UTC monthly paydays. `src/LitUSD.sol` provides a test token with an hourly faucet.

Run checks from this directory:

```bash
forge test --json
forge fmt --check src/Calendar.sol src/AccruePayroll.sol test/AccruePayroll.t.sol
```

The JSON test output works with the older Foundry installation on macOS. For a concise run, save it to a file.

Deploy from the repository root after configuring `PRIVATE_KEY` and `LITVM_RPC_URL` in `contracts/.env`
and funding the deployer with testnet zkLTC:

```bash
./scripts/deploy-litvm.sh
```

Copy `.env.example` to `.env` to configure deployment. Set `LUSD` to reuse a deployed LitUSD token, or omit
it for a fresh token. `SEED_DEMO=0` skips demo setup; enabling it requires the three `DEMO_*_PRIVATE_KEY`
values for dedicated testnet wallets. All signing keys belong in the ignored local environment.
The script validates chain 4441, runs the tests, deploys the contracts, updates the web app, attempts explorer
verification, and seeds a demo payroll. See [the project README](../README.md) for network and local setup details.
