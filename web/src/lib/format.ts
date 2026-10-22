import { parseUnits } from "viem";

export const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// The first comma separates name and role; legacy labels use spaced punctuation.
export function parseLabel(label: string): { name: string; role: string } {
  const comma = label.indexOf(",");
  if (comma >= 0) return { name: squash(label.slice(0, comma)), role: squash(label.slice(comma + 1)) };
  const legacy = label.match(/^(.*?)\s+[·\-–—|]\s+(.+)$/);
  if (legacy) return { name: squash(legacy[1]), role: squash(legacy[2]) };
  return { name: squash(label), role: "" };
}

export const formatLabel = ({ name, role }: { name: string; role: string }) => (role ? `${name}, ${role}` : name);

export const memberName = (label: string, account: string) => parseLabel(label).name || shortAddr(account);

export function displayLabel(label: string, account: string) {
  const { name, role } = parseLabel(label);
  return `${name || shortAddr(account)}${role ? ` · ${role}` : ""}`;
}

function split(value: bigint, decimals: number) {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  return { neg, int: abs / base, frac: (abs % base).toString().padStart(decimals, "0") };
}

export function fmt(value: bigint, decimals = 18, maxFrac = 4): string {
  const original = value;
  const negative = value < 0n;
  if (maxFrac < decimals && value !== 0n) {
    const half = 5n * 10n ** BigInt(decimals - maxFrac - 1);
    value = value < 0n ? value - half : value + half;
  }
  const { neg, int, frac } = split(value, decimals);
  let f = frac.slice(0, maxFrac).replace(/0+$/, "");
  // Keep tiny non-zero amounts visible instead of rounding them to 0.
  if (int === 0n && !f && original !== 0n)
    return `${negative ? "-" : ""}<${maxFrac === 0 ? "1" : `0.${"0".repeat(maxFrac - 1)}1`}`;
  return `${neg ? "-" : ""}${int.toLocaleString("en-US")}${f ? `.${f}` : ""}`;
}

export function parseAmount(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid token decimals.");
  const typed = amount.trim();
  if (!typed) return 0n;
  // Accept thousands separators only in complete groups. Removing arbitrary punctuation can change a payment.
  if (/[,_\s]/.test(typed) && !/^\d{1,3}([,_ ])\d{3}(?:\1\d{3})*(?:\.\d*)?$/.test(typed))
    throw new Error("Use a decimal point and groups of three digits for thousands separators.");
  const cleaned = typed.replace(/[,_ ]/g, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) throw new Error("Enter a valid non-negative amount.");
  const fraction = cleaned.split(".")[1] ?? "";
  if (fraction.slice(decimals).replace(/0/g, "")) throw new Error(`This token supports at most ${decimals} decimal places.`);
  return parseUnits(cleaned, decimals);
}

// Paydays are 00:00 UTC on the org's pay day, so dates are always shown in UTC to match the contract.

export function fmtDate(unixSeconds: number | bigint, withYear = true): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

export const monthName = (unixSeconds: number | bigint) =>
  new Date(Number(unixSeconds) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long" });

/** The same day-of-month `n` months later (pay days are 1-28, so no clamping is needed). */
export function addMonths(unixSeconds: number | bigint, n: number): number {
  const d = new Date(Number(unixSeconds) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()) / 1000;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtDuration(totalSeconds: number, precise = false): string {
  if (!Number.isFinite(totalSeconds)) return "∞";
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (precise) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  if (d >= 365) return `${(d / 365).toFixed(1)}y`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function avatarGradient(address: string): string {
  const n = parseInt(address.slice(2, 10), 16);
  const h1 = n % 360;
  const h2 = (h1 + 40 + ((n >> 9) % 80)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 68%), hsl(${h2} 65% 52%))`;
}
