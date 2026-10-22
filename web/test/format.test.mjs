import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./helpers.mjs";

const { fmt, parseAmount, parseLabel, addMonths } = await importSource("../src/lib/format.ts");

test("whole-unit display keeps small negative balances distinguishable from zero", () => {
  assert.equal(fmt(-1n, 18, 0), "-<1");
  assert.equal(fmt(1n, 18, 0), "<1");
  assert.equal(fmt(0n, 18, 0), "0");
  assert.equal(fmt(-1n, 18, 4), "-<0.0001");
});

test("amounts retain exact token units and supported trailing zeroes", () => {
  assert.equal(parseAmount("8,200.123456", 6), 8_200_123456n);
  assert.equal(parseAmount("0.0000010", 6), 1n);
  assert.equal(parseAmount(".5", 6), 500000n);
  assert.equal(parseAmount("", 18), 0n);
});

test("amounts reject unsupported precision instead of silently rounding a payment", () => {
  assert.throws(() => parseAmount("0.0000009", 6));
  assert.throws(() => parseAmount("1.5", 0));
  assert.throws(() => parseAmount("-10", 18));
  assert.throws(() => parseAmount("1.2.3", 18));
});

test("editing salary units can round-trip the full token precision", () => {
  const salary = 1234567890123456789n;
  assert.equal(parseAmount(fmt(salary, 18, 18), 18), salary);
});

test("payday month changes stay in UTC over year and leap-year boundaries", () => {
  assert.equal(addMonths(Date.UTC(2026, 11, 28) / 1000, 1), Date.UTC(2027, 0, 28) / 1000);
  assert.equal(addMonths(Date.UTC(2028, 0, 28) / 1000, 1), Date.UTC(2028, 1, 28) / 1000);
});

test("member labels keep names and multi-word roles intact", () => {
  assert.deepEqual(parseLabel(" Sam Jay , Head of Design "), { name: "Sam Jay", role: "Head of Design" });
  assert.deepEqual(parseLabel("Sam Jay · Design"), { name: "Sam Jay", role: "Design" });
});
