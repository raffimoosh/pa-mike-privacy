import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { BankDataProvider, ProviderCardTransaction } from "../providers/bank-data.js";
import type { MoneyMovementProvider } from "../providers/money-movement.js";
import { nowISO, todayISO, type Clock } from "./clock.js";
import { addDays, compareDates, maxDate } from "./dates.js";
import { sumAmounts, type Cents } from "./money.js";
import { deriveStatement } from "./statement.js";
import type {
  Account,
  AccountKind,
  CardTransaction,
  Hold,
  Payment,
  StatementSchedule,
  Transfer,
  TransferKind,
  User,
  UserSettings,
} from "./types.js";

export interface EngineDeps {
  store: Store;
  bankData: BankDataProvider;
  money: MoneyMovementProvider;
  clock: Clock;
}

export const DEFAULT_SETTINGS: UserSettings = {
  paymentLeadDays: 3,
  checkingBuffer: 10_000, // $100
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emit(deps: EngineDeps, userId: string, type: string, data: Record<string, unknown> = {}) {
  await deps.store.events.put({ id: randomUUID(), userId, type, at: nowISO(deps.clock), data });
}

async function requireUser(store: Store, userId: string): Promise<User> {
  const user = await store.users.get(userId);
  if (!user) throw new Error(`Unknown user ${userId}`);
  return user;
}

async function requireAccount(store: Store, accountId: string, kind?: AccountKind): Promise<Account> {
  const account = await store.accounts.get(accountId);
  if (!account) throw new Error(`Unknown account ${accountId}`);
  if (kind && account.kind !== kind) throw new Error(`Account ${accountId} is ${account.kind}, expected ${kind}`);
  return account;
}

async function userAccount(store: Store, userId: string, kind: AccountKind): Promise<Account> {
  const account = await store.accounts.find((a) => a.userId === userId && a.kind === kind);
  if (!account) throw new Error(`User ${userId} has no ${kind} account`);
  return account;
}

/** Oldest purchase first, then creation order. */
function byAge(a: Hold, b: Hold): number {
  return compareDates(a.txnDate, b.txnDate) || a.createdAt.localeCompare(b.createdAt);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export async function createUser(deps: EngineDeps, email: string, settings: Partial<UserSettings> = {}): Promise<User> {
  const user: User = {
    id: randomUUID(),
    email,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    createdAt: nowISO(deps.clock),
  };
  await deps.store.users.put(user);
  const holding = await deps.money.createHoldingAccount(user.id);
  await deps.store.accounts.put({
    id: randomUUID(),
    userId: user.id,
    kind: "HOLDING",
    providerAccountId: holding.providerAccountId,
    name: "Holding account",
    mask: "",
  });
  await emit(deps, user.id, "user.created");
  return user;
}

export async function linkAccount(
  deps: EngineDeps,
  userId: string,
  input: {
    kind: "CHECKING" | "CREDIT_CARD";
    providerAccountId: string;
    name: string;
    mask: string;
    providerRefs?: Record<string, string>;
    statementSchedule?: StatementSchedule;
  },
): Promise<Account> {
  await requireUser(deps.store, userId);
  const account: Account = { id: randomUUID(), userId, ...input };
  await deps.store.accounts.put(account);
  await emit(deps, userId, "account.linked", { accountId: account.id, kind: account.kind });
  return account;
}

// ---------------------------------------------------------------------------
// 1. Card transactions -> holds
// ---------------------------------------------------------------------------

/**
 * Ingest one transaction update from the bank data provider and keep the
 * matching Hold in sync. Idempotent: the same update can be delivered twice.
 */
export async function ingestCardTransaction(
  deps: EngineDeps,
  cardAccountId: string,
  incoming: ProviderCardTransaction,
): Promise<{ transaction?: CardTransaction; hold?: Hold }> {
  const { store } = deps;
  const card = await requireAccount(store, cardAccountId, "CREDIT_CARD");
  const userId = card.userId;

  let txn = await store.cardTransactions.find(
    (t) => t.cardAccountId === cardAccountId && t.providerTxnId === incoming.providerTxnId,
  );
  if (!txn && incoming.pendingTransactionId) {
    // A posted transaction replacing a pending authorization we already know about.
    txn = await store.cardTransactions.find(
      (t) => t.cardAccountId === cardAccountId && t.providerTxnId === incoming.pendingTransactionId,
    );
  }

  if (incoming.removed) {
    if (!txn) return {};
    txn.status = "REMOVED";
    await store.cardTransactions.put(txn);
    for (const hold of await store.holds.list((h) => h.cardTransactionId === txn!.id && h.status === "PENDING" && !h.transferId)) {
      hold.status = "CANCELLED";
      await store.holds.put(hold);
    }
    await emit(deps, userId, "card.transaction.removed", { transactionId: txn.id });
    return { transaction: txn };
  }

  txn = {
    id: txn?.id ?? randomUUID(),
    userId,
    cardAccountId,
    providerTxnId: incoming.providerTxnId,
    providerPendingTxnId: incoming.pendingTransactionId ?? txn?.providerPendingTxnId,
    amount: incoming.amount,
    status: incoming.pending ? "PENDING" : "POSTED",
    date: incoming.date,
    merchant: incoming.merchant,
  };
  await store.cardTransactions.put(txn);

  if (txn.amount <= 0) {
    // Refunds and issuer-side payments. We never match refunds to purchases:
    // the issuer's next statement balance already reflects them, and any
    // over-held money is released when that statement is paid.
    await emit(deps, userId, "card.credit", { transactionId: txn.id, amount: txn.amount });
    return { transaction: txn };
  }

  const holds = await store.holds.list((h) => h.cardTransactionId === txn!.id && h.status !== "CANCELLED");
  if (holds.length === 0) {
    const hold: Hold = {
      id: randomUUID(),
      userId,
      cardAccountId,
      cardTransactionId: txn.id,
      amount: txn.amount,
      status: "PENDING",
      txnDate: txn.date,
      createdAt: nowISO(deps.clock),
    };
    await store.holds.put(hold);
    await emit(deps, userId, "hold.created", { holdId: hold.id, amount: hold.amount, merchant: txn.merchant });
    return { transaction: txn, hold };
  }

  // Amount changed (pending -> posted with tip, FX settlement, etc.).
  const unfunded = holds.find((h) => h.status === "PENDING" && !h.transferId);
  const committed = sumAmounts(holds.filter((h) => h !== unfunded));
  if (unfunded) {
    const target = txn.amount - committed;
    if (target > 0) {
      unfunded.amount = target;
    } else {
      unfunded.status = "CANCELLED";
    }
    await store.holds.put(unfunded);
    return { transaction: txn, hold: unfunded };
  }
  const delta = txn.amount - committed;
  if (delta > 0) {
    const topUp: Hold = {
      id: randomUUID(),
      userId,
      cardAccountId,
      cardTransactionId: txn.id,
      amount: delta,
      status: "PENDING",
      txnDate: txn.date,
      createdAt: nowISO(deps.clock),
    };
    await store.holds.put(topUp);
    await emit(deps, userId, "hold.topup", { holdId: topUp.id, amount: delta });
    return { transaction: txn, hold: topUp };
  }
  // delta <= 0: we hold more than the purchase. The excess is released at statement time.
  return { transaction: txn };
}

/** Pull new transaction updates for a card from the provider and ingest them. */
export async function pollCardTransactions(deps: EngineDeps, cardAccountId: string): Promise<number> {
  const card = await requireAccount(deps.store, cardAccountId, "CREDIT_CARD");
  const page = await deps.bankData.listCardTransactions(card.providerAccountId, card.syncCursor);
  for (const t of page.transactions) await ingestCardTransaction(deps, card.id, t);
  card.syncCursor = page.cursor;
  await deps.store.accounts.put(card);
  return page.transactions.length;
}

// ---------------------------------------------------------------------------
// 2. Transfers
// ---------------------------------------------------------------------------

async function initiateTransfer(
  deps: EngineDeps,
  input: { userId: string; kind: TransferKind; amount: Cents; from: Account; to: Account; description: string },
): Promise<{ transfer: Transfer; settledImmediately: boolean }> {
  const transfer: Transfer = {
    id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    amount: input.amount,
    status: "PENDING",
    fromAccountId: input.from.id,
    toAccountId: input.to.id,
    createdAt: nowISO(deps.clock),
  };
  await deps.store.transfers.put(transfer);
  const result = await deps.money.createTransfer({
    kind: input.kind,
    amount: input.amount,
    fromProviderAccountId: input.from.providerAccountId,
    toProviderAccountId: input.to.providerAccountId,
    idempotencyKey: transfer.id,
    description: input.description,
  });
  transfer.providerTransferId = result.providerTransferId;
  await deps.store.transfers.put(transfer);
  await emit(deps, input.userId, "transfer.initiated", { transferId: transfer.id, kind: transfer.kind, amount: transfer.amount });
  return { transfer, settledImmediately: result.status === "SETTLED" };
}

export async function onTransferSettled(deps: EngineDeps, transferId: string): Promise<void> {
  const { store } = deps;
  const transfer = await store.transfers.get(transferId);
  if (!transfer) throw new Error(`Unknown transfer ${transferId}`);
  if (transfer.status === "SETTLED") return;
  transfer.status = "SETTLED";
  transfer.settledAt = nowISO(deps.clock);
  await store.transfers.put(transfer);

  switch (transfer.kind) {
    case "FUND":
      for (const hold of await store.holds.list((h) => h.transferId === transferId && h.status === "PENDING")) {
        hold.status = "FUNDED";
        await store.holds.put(hold);
      }
      break;
    case "PAY_CARD": {
      const payment = await store.payments.find((p) => p.transferId === transferId);
      if (payment) {
        payment.status = "PAID";
        await store.payments.put(payment);
        for (const hold of await store.holds.list((h) => h.paymentId === payment.id && h.status === "FUNDED")) {
          hold.status = "APPLIED";
          await store.holds.put(hold);
        }
        await emit(deps, transfer.userId, "payment.paid", { paymentId: payment.id, amount: payment.amount });
      }
      break;
    }
    case "RELEASE":
      for (const hold of await store.holds.list((h) => h.releaseTransferId === transferId && h.status === "FUNDED")) {
        hold.status = "RELEASED";
        await store.holds.put(hold);
      }
      break;
  }
  await emit(deps, transfer.userId, "transfer.settled", { transferId, kind: transfer.kind, amount: transfer.amount });
}

/** A transfer failed before settlement (NSF, bad account) or was returned afterwards. */
export async function onTransferFailed(
  deps: EngineDeps,
  transferId: string,
  reason: string,
  returned = false,
): Promise<void> {
  const { store } = deps;
  const transfer = await store.transfers.get(transferId);
  if (!transfer) throw new Error(`Unknown transfer ${transferId}`);
  transfer.status = returned ? "RETURNED" : "FAILED";
  transfer.failureReason = reason;
  await store.transfers.put(transfer);

  switch (transfer.kind) {
    case "FUND":
      // Put the holds back in the queue so the next sweep retries them.
      for (const hold of await store.holds.list((h) => h.transferId === transferId)) {
        if (hold.status === "APPLIED") {
          // Money already went to the card and then bounced from checking: an ops case, not something to retry.
          await emit(deps, transfer.userId, "transfer.returned_after_apply", { transferId, holdId: hold.id, amount: hold.amount });
          continue;
        }
        hold.status = "PENDING";
        hold.transferId = undefined;
        await store.holds.put(hold);
      }
      break;
    case "PAY_CARD": {
      const payment = await store.payments.find((p) => p.transferId === transferId);
      if (payment) {
        payment.status = "SCHEDULED";
        payment.amount = undefined;
        payment.transferId = undefined;
        await store.payments.put(payment);
        for (const hold of await store.holds.list((h) => h.paymentId === payment.id)) {
          hold.paymentId = undefined;
          hold.status = "FUNDED";
          await store.holds.put(hold);
        }
        await emit(deps, transfer.userId, "payment.failed", { paymentId: payment.id, reason });
      }
      break;
    }
    case "RELEASE":
      for (const hold of await store.holds.list((h) => h.releaseTransferId === transferId)) {
        hold.releaseTransferId = undefined;
        hold.status = "FUNDED";
        await store.holds.put(hold);
      }
      break;
  }
  await emit(deps, transfer.userId, "transfer.failed", { transferId, kind: transfer.kind, reason, returned });
}

/** Entry point for the money-movement provider's webhook. */
export async function handleTransferWebhook(
  deps: EngineDeps,
  event: { providerTransferId: string; status: "SETTLED" | "FAILED" | "RETURNED"; reason?: string },
): Promise<Transfer> {
  const transfer = await deps.store.transfers.find((t) => t.providerTransferId === event.providerTransferId);
  if (!transfer) throw new Error(`No transfer with provider id ${event.providerTransferId}`);
  if (event.status === "SETTLED") await onTransferSettled(deps, transfer.id);
  else await onTransferFailed(deps, transfer.id, event.reason ?? event.status, event.status === "RETURNED");
  return (await deps.store.transfers.get(transfer.id))!;
}

// ---------------------------------------------------------------------------
// 3. Daily sweep: checking -> holding
// ---------------------------------------------------------------------------

/**
 * Batch every unfunded hold into one ACH pull from checking. One pull per day
 * keeps provider fees down and gives the user a single predictable line item.
 * Holds that would push checking below the user's buffer wait for the next day.
 */
export async function runDailySweep(deps: EngineDeps, userId: string): Promise<Transfer | undefined> {
  const { store } = deps;
  const user = await requireUser(store, userId);
  const pending = (await store.holds.list((h) => h.userId === userId && h.status === "PENDING" && !h.transferId)).sort(byAge);
  if (pending.length === 0) return undefined;

  const checking = await userAccount(store, userId, "CHECKING");
  const holding = await userAccount(store, userId, "HOLDING");
  const available = await deps.bankData.getAvailableBalance(checking.providerAccountId);
  const budget = available - user.settings.checkingBuffer;

  const selected: Hold[] = [];
  let total = 0;
  for (const hold of pending) {
    if (total + hold.amount <= budget) {
      selected.push(hold);
      total += hold.amount;
    }
  }
  const skipped = pending.filter((h) => !selected.includes(h));
  if (skipped.length > 0) {
    await emit(deps, userId, "sweep.shortfall", {
      skippedCount: skipped.length,
      skippedAmount: sumAmounts(skipped),
      available,
      buffer: user.settings.checkingBuffer,
    });
  }
  if (selected.length === 0) return undefined;

  const { transfer, settledImmediately } = await initiateTransfer(deps, {
    userId,
    kind: "FUND",
    amount: total,
    from: checking,
    to: holding,
    description: `Card purchases set aside (${selected.length})`,
  });
  for (const hold of selected) {
    hold.transferId = transfer.id;
    await store.holds.put(hold);
  }
  await emit(deps, userId, "sweep.initiated", { transferId: transfer.id, amount: total, holds: selected.length });
  if (settledImmediately) await onTransferSettled(deps, transfer.id);
  return transfer;
}

// ---------------------------------------------------------------------------
// 4. Statements and payment scheduling
// ---------------------------------------------------------------------------

/**
 * Refresh the card's statement and schedule a payment for it if needed.
 * Prefers issuer data from the provider; falls back to a statement derived
 * from our own transaction history when the card has a configured schedule.
 */
export async function syncCardStatement(deps: EngineDeps, cardAccountId: string): Promise<Payment | undefined> {
  const { store } = deps;
  const card = await requireAccount(store, cardAccountId, "CREDIT_CARD");
  const liability =
    (await deps.bankData.getCardLiability(card.providerAccountId)) ??
    (await deriveStatement(store, card, todayISO(deps.clock)));
  if (!liability) return undefined;

  card.statement = {
    issueDate: liability.lastStatementIssueDate,
    balance: liability.lastStatementBalance,
    minimumPayment: liability.minimumPaymentAmount,
    dueDate: liability.nextPaymentDueDate,
  };
  await store.accounts.put(card);
  if (card.statement.balance <= 0) return undefined;

  const existing = await store.payments.find(
    (p) => p.cardAccountId === card.id && p.statementIssueDate === liability.lastStatementIssueDate,
  );
  if (existing) return existing;

  const user = await requireUser(store, card.userId);
  const payment: Payment = {
    id: randomUUID(),
    userId: card.userId,
    cardAccountId: card.id,
    statementIssueDate: card.statement.issueDate,
    statementBalance: card.statement.balance,
    minimumPayment: card.statement.minimumPayment,
    dueDate: card.statement.dueDate,
    scheduledDate: maxDate(todayISO(deps.clock), addDays(card.statement.dueDate, -user.settings.paymentLeadDays)),
    status: "SCHEDULED",
  };
  await store.payments.put(payment);
  await emit(deps, card.userId, "payment.scheduled", {
    paymentId: payment.id,
    scheduledDate: payment.scheduledDate,
    statementBalance: payment.statementBalance,
  });
  return payment;
}

/** Consume holds oldest-first up to `amount`, splitting the last one if needed. */
async function allocateHolds(
  store: Store,
  holds: Hold[],
  amount: Cents,
  paymentId: string,
): Promise<{ applied: Hold[]; remaining: Hold[] }> {
  const applied: Hold[] = [];
  const remaining: Hold[] = [];
  let need = amount;
  for (const hold of holds) {
    if (need <= 0) {
      remaining.push(hold);
      continue;
    }
    if (hold.amount <= need) {
      hold.paymentId = paymentId;
      await store.holds.put(hold);
      applied.push(hold);
      need -= hold.amount;
      continue;
    }
    const rest: Hold = { ...hold, id: randomUUID(), amount: hold.amount - need, paymentId: undefined };
    hold.amount = need;
    hold.paymentId = paymentId;
    await store.holds.put(hold);
    await store.holds.put(rest);
    applied.push(hold);
    remaining.push(rest);
    need = 0;
  }
  return { applied, remaining };
}

/**
 * Pay every statement whose scheduled date has arrived, using the holds that
 * belong to that statement cycle (purchases dated on or before the statement
 * close). Anything held for that cycle beyond the statement balance (refunds,
 * amount corrections) goes back to checking.
 */
export async function executeDuePayments(deps: EngineDeps, userId: string): Promise<Payment[]> {
  const { store } = deps;
  const today = todayISO(deps.clock);
  const due = await store.payments.list((p) => p.userId === userId && p.status === "SCHEDULED" && p.scheduledDate <= today);
  const results: Payment[] = [];

  for (const payment of due) {
    const card = await requireAccount(store, payment.cardAccountId, "CREDIT_CARD");
    const holding = await userAccount(store, userId, "HOLDING");
    const checking = await userAccount(store, userId, "CHECKING");

    const cycleHolds = (
      await store.holds.list(
        (h) =>
          h.cardAccountId === card.id &&
          h.status === "FUNDED" &&
          !h.paymentId &&
          !h.releaseTransferId &&
          h.txnDate <= payment.statementIssueDate,
      )
    ).sort(byAge);
    const funded = sumAmounts(cycleHolds);
    const amount = Math.min(payment.statementBalance, funded);

    if (amount <= 0) {
      await emit(deps, userId, "payment.unfunded", { paymentId: payment.id, statementBalance: payment.statementBalance });
      continue;
    }

    const { remaining } = await allocateHolds(store, cycleHolds, amount, payment.id);
    const { transfer, settledImmediately } = await initiateTransfer(deps, {
      userId,
      kind: "PAY_CARD",
      amount,
      from: holding,
      to: card,
      description: `Payment for statement ${payment.statementIssueDate}`,
    });
    payment.amount = amount;
    payment.status = "INITIATED";
    payment.transferId = transfer.id;
    await store.payments.put(payment);
    await emit(deps, userId, "payment.initiated", { paymentId: payment.id, amount, statementBalance: payment.statementBalance });
    if (amount < payment.statementBalance) {
      await emit(deps, userId, "payment.partial", {
        paymentId: payment.id,
        shortfall: payment.statementBalance - amount,
        belowMinimum: amount < payment.minimumPayment,
      });
    }
    if (settledImmediately) await onTransferSettled(deps, transfer.id);

    if (remaining.length > 0) {
      const release = await initiateTransfer(deps, {
        userId,
        kind: "RELEASE",
        amount: sumAmounts(remaining),
        from: holding,
        to: checking,
        description: `Returned: held more than statement ${payment.statementIssueDate}`,
      });
      for (const hold of remaining) {
        hold.releaseTransferId = release.transfer.id;
        await store.holds.put(hold);
      }
      await emit(deps, userId, "holds.released", { transferId: release.transfer.id, amount: release.transfer.amount });
      if (release.settledImmediately) await onTransferSettled(deps, release.transfer.id);
    }
    results.push((await store.payments.get(payment.id))!);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 5. Daily job and read model
// ---------------------------------------------------------------------------

export interface DailyRunSummary {
  transactionsIngested: number;
  sweep?: Transfer;
  payments: Payment[];
}

/** What a scheduler runs once a day per user (after provider webhooks have been processed). */
export async function runDailyJobs(deps: EngineDeps, userId: string): Promise<DailyRunSummary> {
  const cards = await deps.store.accounts.list((a) => a.userId === userId && a.kind === "CREDIT_CARD");
  let transactionsIngested = 0;
  for (const card of cards) {
    transactionsIngested += await pollCardTransactions(deps, card.id);
    await syncCardStatement(deps, card.id);
  }
  const sweep = await runDailySweep(deps, userId);
  const payments = await executeDuePayments(deps, userId);
  return { transactionsIngested, sweep, payments };
}

export interface Overview {
  user: User;
  holdingBalance: Cents;
  awaitingFunding: Cents;
  inFlight: Cents;
  cards: Array<{
    account: Account;
    reserved: Cents;
    nextPayment?: Payment;
  }>;
  recentEvents: Array<{ type: string; at: string; data: Record<string, unknown> }>;
}

export async function getOverview(deps: EngineDeps, userId: string): Promise<Overview> {
  const { store } = deps;
  const user = await requireUser(store, userId);
  const transfers = await store.transfers.list((t) => t.userId === userId && t.status === "SETTLED");
  const holdingBalance =
    sumAmounts(transfers.filter((t) => t.kind === "FUND")) -
    sumAmounts(transfers.filter((t) => t.kind !== "FUND"));
  const holds = await store.holds.list((h) => h.userId === userId);
  const awaitingFunding = sumAmounts(holds.filter((h) => h.status === "PENDING" && !h.transferId));
  const inFlight = sumAmounts(holds.filter((h) => h.status === "PENDING" && !!h.transferId));

  const cards = [];
  for (const account of await store.accounts.list((a) => a.userId === userId && a.kind === "CREDIT_CARD")) {
    const reserved = sumAmounts(holds.filter((h) => h.cardAccountId === account.id && h.status === "FUNDED" && !h.paymentId && !h.releaseTransferId));
    const nextPayment = (await store.payments.list((p) => p.cardAccountId === account.id && p.status !== "PAID"))
      .sort((a, b) => compareDates(a.scheduledDate, b.scheduledDate))[0];
    cards.push({ account, reserved, nextPayment });
  }

  const recentEvents = (await store.events.list((e) => e.userId === userId))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
    .map(({ type, at, data }) => ({ type, at, data }));

  return { user, holdingBalance, awaitingFunding, inFlight, cards, recentEvents };
}
