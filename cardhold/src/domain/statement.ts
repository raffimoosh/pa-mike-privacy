import type { Store } from "./store.js";
import type { Account } from "./types.js";
import { addDays, type ISODate } from "./dates.js";
import type { ProviderCardLiability } from "../providers/bank-data.js";

/** `day` clamped to the length of the month. */
function dateInMonth(year: number, monthIndex: number, day: number): ISODate {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function parts(date: ISODate): { year: number; monthIndex: number } {
  const d = new Date(`${date}T00:00:00Z`);
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

/** Latest date on or before `date` whose day-of-month is `day`. */
export function latestOnOrBefore(date: ISODate, day: number): ISODate {
  const { year, monthIndex } = parts(date);
  const candidate = dateInMonth(year, monthIndex, day);
  return candidate <= date ? candidate : dateInMonth(year, monthIndex - 1, day);
}

/** First date strictly after `date` whose day-of-month is `day`. */
export function firstAfter(date: ISODate, day: number): ISODate {
  const { year, monthIndex } = parts(date);
  const candidate = dateInMonth(year, monthIndex, day);
  return candidate > date ? candidate : dateInMonth(year, monthIndex + 1, day);
}

/**
 * Derive the most recent statement for a card from its configured cycle and
 * the transactions we have ingested. Used when the bank data provider has no
 * liabilities data.
 *
 *   balance = carry-over from the previous statement (what we did not pay)
 *           + purchases in the cycle
 *           - refunds and other credits in the cycle
 *   where credits that match a card payment we sent are excluded, since the
 *   carry-over already accounts for our payments.
 *
 * Interest and fees show up as issuer-posted transactions and are included.
 */
export async function deriveStatement(store: Store, card: Account, today: ISODate): Promise<ProviderCardLiability | undefined> {
  const schedule = card.statementSchedule;
  if (!schedule) return undefined;

  const issueDate = latestOnOrBefore(today, schedule.closeDay);
  const previousIssueDate = latestOnOrBefore(addDays(issueDate, -1), schedule.closeDay);
  const dueDate = firstAfter(issueDate, schedule.dueDay);

  const cycle = await store.cardTransactions.list(
    (t) => t.cardAccountId === card.id && t.status !== "REMOVED" && t.date > previousIssueDate && t.date <= issueDate,
  );

  // Our own payments to this card land as credits on the card; drop one credit per payment.
  const ourPayments = await store.transfers.list(
    (t) =>
      t.kind === "PAY_CARD" &&
      t.toAccountId === card.id &&
      t.status !== "FAILED" &&
      t.createdAt.slice(0, 10) > addDays(previousIssueDate, -10) &&
      t.createdAt.slice(0, 10) <= issueDate,
  );
  const excluded = new Set<string>();
  for (const payment of ourPayments) {
    const match = cycle.find((t) => !excluded.has(t.id) && t.amount === -payment.amount);
    if (match) excluded.add(match.id);
  }

  const previous = await store.payments.find((p) => p.cardAccountId === card.id && p.statementIssueDate === previousIssueDate);
  const carryOver = previous ? previous.statementBalance - (previous.amount ?? 0) : 0;

  const cycleTotal = cycle.filter((t) => !excluded.has(t.id)).reduce((sum, t) => sum + t.amount, 0);
  const balance = Math.max(0, carryOver + cycleTotal);

  return {
    lastStatementIssueDate: issueDate,
    lastStatementBalance: balance,
    minimumPaymentAmount: schedule.minimumPayment ?? 0,
    nextPaymentDueDate: dueDate,
  };
}
