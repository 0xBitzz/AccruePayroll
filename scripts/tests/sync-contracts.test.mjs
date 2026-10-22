import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
const payroll = "0x1111111111111111111111111111111111111111";
const lusd = "0x2222222222222222222222222222222222222222";
const payrollHash = `0x${"a".repeat(64)}`;
const lusdHash = `0x${"b".repeat(64)}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "AccruePayroll-sync-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "web/src/lib", "contracts/out/AccruePayroll.sol", "contracts/out/LitUSD.sol", "contracts/broadcast/Deploy.s.sol/4441"])
    mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(scripts, "sync-contracts.mjs"), join(root, "scripts/sync-contracts.mjs"));
  for (const [name, object] of [["AccruePayroll", "0x1234"], ["LitUSD", "0x5678"]])
    writeFileSync(join(root, `contracts/out/${name}.sol/${name}.json`), JSON.stringify({ abi: [], bytecode: { object } }));
  const target = join(root, "web/src/lib/generated.ts");
  writeFileSync(target, "existing confirmed deployment");
  const run = {
    chain: 4441,
    pending: [],
    transactions: [{ hash: payrollHash, transactionType: "CREATE", contractName: "AccruePayroll", contractAddress: payroll, transaction: { data: "0x1234" } }],
    receipts: [{ transactionHash: payrollHash, contractAddress: payroll, status: "0x1", blockNumber: "0x10" }],
    returns: { payroll: { value: payroll }, lusd: { value: lusd } },
  };
  const broadcast = join(root, "contracts/broadcast/Deploy.s.sol/4441/run-latest.json");
  const sync = () => {
    writeFileSync(broadcast, JSON.stringify(run));
    const env = { ...process.env, CHAIN_ID: "4441" };
    delete env.BROADCAST_FILE;
    delete env.LUSD;
    return spawnSync(process.execPath, [join(root, "scripts/sync-contracts.mjs")], { env, encoding: "utf8" });
  };
  return { run, target, sync };
}

test("sync recovers a reused LitUSD from script returns without an LUSD environment variable", (t) => {
  const f = fixture(t);
  assert.equal(f.sync().status, 0);
  const generated = readFileSync(f.target, "utf8");
  assert.ok(generated.includes(`lusd: "${lusd}"`));
  assert.ok(generated.includes("deployBlock: 16"));
});

test("sync checks both creation receipts when a new LitUSD is deployed", (t) => {
  const f = fixture(t);
  f.run.transactions.push({ hash: lusdHash, transactionType: "CREATE", contractName: "LitUSD", contractAddress: lusd, transaction: { input: "0x5678" } });
  f.run.receipts.push({ transactionHash: lusdHash, contractAddress: lusd, status: "0x1", blockNumber: "0x11" });
  assert.equal(f.sync().status, 0);
  assert.ok(readFileSync(f.target, "utf8").includes(`lusd: "${lusd}"`));
});

for (const [name, mutate] of [
  ["wrong chain", (r) => { r.chain = 31337; }],
  ["missing receipts", (r) => { r.receipts = []; }],
  ["reverted creation", (r) => { r.receipts[0].status = "0x0"; }],
  ["receipt for a different transaction", (r) => { r.receipts[0].transactionHash = lusdHash; }],
  ["missing transaction hashes", (r) => { delete r.transactions[0].hash; delete r.receipts[0].transactionHash; }],
  ["malformed transaction hash", (r) => { r.transactions[0].hash = r.receipts[0].transactionHash = "0xabc"; }],
  ["receipt for a different address", (r) => { r.receipts[0].contractAddress = lusd; }],
  ["stale creation bytecode", (r) => { r.transactions[0].transaction.data = "0xbeef"; }],
  ["pending transactions", (r) => { r.pending = [payrollHash]; }],
  ["invalid token address", (r) => { r.returns.lusd.value = "0x"; }],
  ["payroll return for a different address", (r) => { r.returns.payroll.value = lusd; }],
  ["token return for a different address", (r) => {
    r.transactions.push({ hash: lusdHash, transactionType: "CREATE", contractName: "LitUSD", contractAddress: lusd, transaction: { data: "0x5678" } });
    r.receipts.push({ transactionHash: lusdHash, contractAddress: lusd, status: "0x1", blockNumber: "0x11" });
    r.returns.lusd.value = payroll;
  }],
]) {
  test(`sync preserves the web deployment when there is ${name}`, (t) => {
    const f = fixture(t);
    mutate(f.run);
    assert.notEqual(f.sync().status, 0);
    assert.equal(readFileSync(f.target, "utf8"), "existing confirmed deployment");
  });
}
