/** Read CSV or spreadsheet rows without splitting punctuation inside quoted fields. */
export function parseDelimitedRows(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const first = input.split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("#")) ?? "";
  let delimiter = ",";
  let inQuotes = false;
  for (const char of first) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && [",", ";", "\t"].includes(char)) {
      delimiter = char;
      break;
    }
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const finishField = () => {
    row.push(field.trim());
    field = "";
    closed = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; ++i) {
    const char = input[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') {
        field += '"';
        ++i;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (row.length === 0 && !field.trim() && !closed && char === "#") {
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") ++i;
      field = "";
      if (input[i] === "\r" && input[i + 1] === "\n") ++i;
    } else if (char === delimiter) finishField();
    else if (char === "\n" || char === "\r") {
      finishRow();
      if (char === "\r" && input[i + 1] === "\n") ++i;
    } else if (char === '"') {
      if (field.trim() || closed) throw new Error("Quotes must enclose a complete field.");
      field = "";
      quoted = true;
    } else if (closed) {
      if (char.trim()) throw new Error("Unexpected text after a quoted field.");
    } else field += char;
  }
  if (quoted) throw new Error("A quoted field is missing its closing quote.");
  if (row.length || field || closed) finishRow();
  return rows;
}

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
