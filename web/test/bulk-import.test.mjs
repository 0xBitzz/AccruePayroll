import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./helpers.mjs";

const { parseBulkMembers } = await importSource("../src/lib/bulk-import.ts");
const { parseDelimitedRows } = await importSource("../src/lib/csv.ts");
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";

test("quoted salaries and comma-separated roles retain their values", () => {
  const [row] = parseBulkMembers(`${alice},"8,200.123456",Sam Jay,"Head of Design, Research"`, 6);
  assert.equal(row.error, undefined);
  assert.equal(row.salary, 8_200_123456n);
  assert.equal(row.label, "Sam Jay, Head of Design, Research");
});

test("spreadsheet and semicolon rows keep commas inside amounts", () => {
  for (const delimiter of ["\t", ";"]) {
    const rows = parseBulkMembers(`address${delimiter}salary${delimiter}name${delimiter}role\r\n${alice}${delimiter}8,200${delimiter}Sam Jay${delimiter}Design`, 18);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].error, undefined);
    assert.equal(rows[0].salary, 8_200n * 10n ** 18n);
  }
});

test("CSV supports escaped quotes, multiline fields, comments and a byte-order mark", () => {
  const rows = parseDelimitedRows('\uFEFF# comment\r\nname,role\r\n"Sam ""Jay""","Design\nResearch"\r\n');
  assert.deepEqual(rows, [["name", "role"], ['Sam "Jay"', "Design\nResearch"]]);
  assert.deepEqual(parseDelimitedRows("# comment,ignored\n"), []);
});

test("malformed CSV cannot produce a payable import row", () => {
  for (const input of [`${alice},"8200,Sam`, `${alice},"8200"oops,Sam`, `${alice},82"00,Sam`]) {
    const rows = parseBulkMembers(input, 18);
    assert.ok(rows[0].error);
    assert.equal(rows[0].salary, undefined);
  }
});

test("missing salaries, duplicate wallets and unsupported precision block import", () => {
  const rows = parseBulkMembers(`${alice},,Sam\n${bob},0,Ada\n${bob},1,Ada\n${alice},1.0000001,Sam`, 6);
  assert.match(rows[0].error, /missing salary/);
  assert.equal(rows[1].salary, 0n);
  assert.match(rows[2].error, /duplicate/);
  assert.ok(rows[3].error);
  const [precision] = parseBulkMembers(`${alice},1.0000001,Sam`, 6);
  assert.match(precision.error, /decimal places/);
});

test("the payroll contract cannot be imported as an employee wallet", () => {
  const [row] = parseBulkMembers(`${alice},8200,Sam`, 18, alice);
  assert.match(row.error, /payroll contract/);
  assert.equal(row.salary, undefined);
});
