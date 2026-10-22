import { isAddress, maxUint128, zeroAddress } from "viem";
import { parseDelimitedRows } from "./csv";
import { formatLabel, parseAmount, parseLabel } from "./format";

export type ImportRow = { address: string; monthly: string; label: string; error?: string; salary?: bigint };

export function parseBulkMembers(text: string, decimals: number, payrollAddress?: string | null): ImportRow[] {
  let records: string[][];
  try {
    records = parseDelimitedRows(text);
  } catch (error) {
    return [{ address: "", monthly: "", label: "", error: (error as Error).message }];
  }
  const seen = new Set<string>();
  return records.filter(([address]) => address.toLowerCase() !== "address").map(([address = "", amount = "", ...rest]) => {
    const label = formatLabel(parseLabel(rest.join(", ")));
    const row: ImportRow = { address, monthly: amount, label };
    const key = address.toLowerCase();
    if (!isAddress(address) || key === zeroAddress) row.error = "bad address";
    else if (key === payrollAddress?.toLowerCase()) row.error = "use the employee's wallet, not the payroll contract";
    else if (seen.has(key)) row.error = "duplicate address";
    else if (!parseLabel(label).name) row.error = "missing name";
    else if (!amount) row.error = "missing salary (use 0 for bonus-only)";
    else {
      try {
        row.salary = parseAmount(amount, decimals);
        if (row.salary > maxUint128) row.error = "salary exceeds the supported maximum";
      } catch (error) {
        row.error = (error as Error).message;
      }
    }
    seen.add(key);
    return row;
  });
}
