# AccruePayroll

**Monthly payroll on [LitVM](https://docs.litvm.com), Litecoin’s EVM layer.**

AccruePayroll helps teams manage salaries, fund payroll, and pay employees directly from a shared treasury. Employers choose a monthly payday, add their team, and send all payable salaries in one transaction. Employees confirm their payout wallets, optionally split incoming payments between wallets, and view their payslips on-chain.

The contracts track unpaid salaries and reserve payroll obligations when calculating the surplus available for bonuses and employer withdrawals. The app reads payroll data directly from the blockchain, without a backend or an indexer.

Built for the **LitVM LiteForge testnet**, using Solidity and Foundry for the contracts, and React, TypeScript, Vite, and viem for the frontend.

## Testnet contracts

| Contract | Address |
|---|---|
| AccruePayroll | [`0xc0a0B22D202Bd9Ef3D8C0Ca5eeDCd90558e99500`](https://liteforge.explorer.caldera.xyz/address/0xc0a0B22D202Bd9Ef3D8C0Ca5eeDCd90558e99500) |
| LitUSD — test payroll token | [`0x43011Da0B111e3b319ED6973A13b64124343B691`](https://liteforge.explorer.caldera.xyz/address/0x43011Da0B111e3b319ED6973A13b64124343B691) |

## Features

| Feature | Description |
|---|---|
| **Monthly paydays** | Choose a payday from the 1st–28th, at 00:00 UTC. Each eligible payday adds the employee’s full monthly salary. |
| **Batch payroll** | Preview each payment, then pay the team in one transaction. Missed monthly payments accumulate for a later run. |
| **Salary reserves** | Owed salaries and the next payroll are excluded from the surplus available for bonuses and employer withdrawals. |
| **Wallet confirmation** | Employees confirm their payout wallet before receiving salaries or bonuses. Unconfirmed salaries remain owed. |
| **Protected wallet changes** | Payout changes wait 48 hours and require acceptance from the new wallet. The employer or current wallet can cancel during the wait. |
| **Team management** | Add employees individually or import CSV rows. Update salaries, pause or resume members, remove employees, and rehire them. |
| **Instant bonuses** | Send individual or batch bonuses from treasury surplus, with an on-chain memo. |
| **Auto-split payouts** | Employees route a percentage of each payment to a second wallet, such as a savings or tax wallet. |
| **Resilient transfers** | Failed recipients stay owed while payroll continues. A rejected split falls back to paying the primary wallet. |
| **Payment history** | View payroll activity and personal payslips, and export either to CSV. |
| **Flexible payment assets** | Pay in native zkLTC, LitUSD, or supported ERC-20 tokens. LitUSD includes a testnet faucet. |

## How it works

1. **Create a payroll.** The employer selects a payment asset and monthly payday, then adds employee wallet addresses and salaries.
2. **Confirm payout wallets.** Each employee connects the wallet added by their employer, opens the Employee view, and confirms their payout wallet.
3. **Fund the treasury.** Deposit enough to cover payroll. The dashboard shows amounts due, reserved funds, available surplus, and any funding shortfall.
4. **Run payroll.** On or after payday, the employer reviews the payments and submits the transaction. The contract calculates salaries owed for elapsed paydays and pays eligible wallets.
5. **Receive and review payments.** Salaries and bonuses arrive directly in the employee’s wallet, with any configured split applied. Employees can review payslips and manage their payout settings.

Employees do not need a withdrawal step: the employer’s payment transaction transfers the funds to them. Auto-split controls the destination of future payments; it does not initiate a payout.

`Calendar.sol` counts elapsed monthly paydays in constant time. Salary and status changes settle previously accrued amounts first, preserving what employees earned under their earlier settings. Unconfirmed wallets, pending wallet changes, and failed salary transfers retain unpaid balances for a subsequent payroll run.

## Repository layout

```text
AccruePayroll/
├── contracts/
│   ├── src/
│   │   ├── AccruePayroll.sol   Payroll, treasury, wallets, and payslips
│   │   ├── Calendar.sol        UTC payday calculations
│   │   └── LitUSD.sol          Testnet token and faucet
│   ├── script/                Deployment scripts
│   ├── test/                  Contract tests
│   ├── verification/          Explorer verification inputs and guide
│   └── foundry.toml           Solidity compiler and network settings
├── web/
│   ├── src/                   React app, wallet connection, and contract reads
│   ├── public/                Static assets
│   └── test/                  Frontend utility tests
└── scripts/
    ├── deploy-litvm.sh        LitVM deployment entry point
    ├── sync-contracts.mjs     Sync compiled ABIs and deployed addresses
    ├── litvm-rpc.mjs          Deployment RPC checks
    └── tests/                 Deployment tooling tests
```

## Run guide

Install **Node.js 20+**, npm, and [Foundry](https://getfoundry.sh). Use an Ethereum-compatible browser wallet to interact with the app. Run the following commands from the project root.

### Start the app

```bash
npm --prefix web ci
npm --prefix web run dev
```

Open the URL printed by Vite and connect your wallet. The app uses the LiteForge testnet contracts by default and provides Employer and Employee views.

### Run tests and build

Install the Solidity dependencies if `contracts/lib` is missing:

```bash
forge install --root contracts --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.0.2
```

Run the contract tests, frontend and deployment tests, and production build:

```bash
forge test --root contracts --json
npm --prefix web test
npm --prefix web run build
```

The production app is generated in `web/dist`. Preview it with:

```bash
npm --prefix web run preview
```

### Deploy to Vercel

Import the GitHub repository at [vercel.com/new](https://vercel.com/new) and leave **Root Directory** at the repository root. The included `vercel.json` installs dependencies in `web`, builds the app, and publishes `web/dist`.

The default LiteForge RPC and deployed contract addresses are already configured, so no environment variables are required. To use another RPC endpoint, set `VITE_RPC_URL` in Vercel before building.

For a deployment from your terminal, sign in with `vercel login`, then run from the project root. Link the lowercase project name explicitly; Vercel rejects the uppercase letters in the folder name `AccruePayroll` when creating a project:

```bash
vercel link --yes --project accruepayroll
vercel --prod --yes
```

### Local development with Anvil

Start a local chain in a separate terminal:

```bash
anvil --chain-id 4441
```

In your development terminal, set `PRIVATE_KEY` to an Anvil development account key. From the project root, deploy locally and point the frontend at Anvil:

```bash
(
  cd contracts
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --json
)
node scripts/sync-contracts.mjs
VITE_RPC_URL=http://127.0.0.1:8545 npm --prefix web run dev
```

## Deploy to LitVM

Complete the dependency setup above, then prepare your deployment environment:

```bash
cp -n contracts/.env.example contracts/.env
chmod 600 contracts/.env
```

Set `PRIVATE_KEY` in `contracts/.env` to your deployment wallet’s key. The template includes the LiteForge RPC URL. Keep signing keys in this ignored file; frontend `VITE_*` variables are public.

Fund the deployment wallet with testnet zkLTC from the [LitVM faucet](https://testnet.litvm.com), then run:

```bash
./scripts/deploy-litvm.sh
```

To reuse the existing LitUSD token:

```bash
LUSD=0x43011Da0B111e3b319ED6973A13b64124343B691 ./scripts/deploy-litvm.sh
```

The frontend’s contract addresses and ABIs are updated automatically. Publish the generated `web/dist` directory to a static host. For source verification, see the [contract verification guide](contracts/verification/README.md).
