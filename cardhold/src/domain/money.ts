/** All money is handled as integer cents to avoid floating point drift. */
export type Cents = number;

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`Amount must be integer cents, got ${n}`);
  return n;
}

/** Convert a decimal dollar amount (e.g. from a provider API) to cents. */
export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function formatCents(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function sumAmounts(rows: ReadonlyArray<{ amount: Cents }>): Cents {
  return rows.reduce((acc, r) => acc + r.amount, 0);
}
