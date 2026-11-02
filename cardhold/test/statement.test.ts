import { describe, expect, it } from "vitest";
import {
  FixedClock,
  MockBankDataProvider,
  MockMoneyMovementProvider,
  createMemoryStore,
  createUser,
  deriveStatement,
  executeDuePayments,
  firstAfter,
  handleTransferWebhook,
  ingestCardTransaction,
  latestOnOrBefore,
  linkAccount,
  runDailySweep,
  syncCardStatement,
  type EngineDeps,
} from "../src/index.js";

describe("cycle date helpers", () => {
  it("finds the latest close date on or before today, clamping short months", () => {
    expect(latestOnOrBefore("2026-03-16", 15)).toBe("2026-03-15");
    expect(latestOnOrBefore("2026-03-15", 15)).toBe("2026-03-15");
    expect(latestOnOrBefore("2026-03-14", 15)).toBe("2026-02-15");
    expect(latestOnOrBefore("2026-03-01", 31)).toBe("2026-02-28");
  });
  it("finds the first due date strictly after the close date", () => {
    expect(firstAfter("2026-03-15", 9)).toBe("2026-04-09");
    expect(firstAfter("2026-03-15", 20)).toBe("2026-03-20");
    expect(firstAfter("2026-01-31", 31)).toBe("2026-02-28");
  });
});

async function setup() {
  const clock = new FixedClock("2026-03-16");
  const bankData = new MockBankDataProvider(); // never returns liabilities
  const money = new MockMoneyMovementProvider();
  const deps: EngineDeps = { store: createMemoryStore(), bankData, money, clock };
  const user = await createUser(deps, "s@example.com", { paymentLeadDays: 3 });
  await linkAccount(deps, user.id, { kind: "CHECKING", providerAccountId: "chk", name: "Chk", mask: "1" });
  const card = await linkAccount(deps, user.id, {
    kind: "CREDIT_CARD",
    providerAccountId: "card",
    name: "Visa",
    mask: "2",
    statementSchedule: { closeDay: 15, dueDay: 9, minimumPayment: 2_500 },
  });
  bankData.setBalance("chk", 1_000_000);
  const settleAll = async () => {
    for (const t of money.settleAll()) await handleTransferWebhook(deps, { providerTransferId: t.providerTransferId, status: "SETTLED" });
  };
  return { deps, clock, user, card, settleAll };
}

const txn = (id: string, amount: number, date: string) => ({ providerTxnId: id, amount, pending: false, date, merchant: id });

describe("derived statements (no issuer data)", () => {
  it("sums the cycle's purchases and credits between close dates", async () => {
    const { deps, card } = await setup();
    await ingestCardTransaction(deps, card.id, txn("old", 9_999, "2026-02-15")); // previous cycle (on its close date)
    await ingestCardTransaction(deps, card.id, txn("a", 4_000, "2026-02-16"));
    await ingestCardTransaction(deps, card.id, txn("b", 2_000, "2026-03-15"));
    await ingestCardTransaction(deps, card.id, txn("refund", -500, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, txn("next", 7_000, "2026-03-16")); // next cycle

    expect(await deriveStatement(deps.store, card, "2026-03-16")).toEqual({
      lastStatementIssueDate: "2026-03-15",
      lastStatementBalance: 5_500,
      minimumPaymentAmount: 2_500,
      nextPaymentDueDate: "2026-04-09",
    });
  });

  it("schedules and pays from a derived statement, and excludes our own payment next cycle", async () => {
    const { deps, clock, user, card, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, txn("a", 4_000, "2026-03-01"));
    await ingestCardTransaction(deps, card.id, txn("b", 2_000, "2026-03-10"));
    await runDailySweep(deps, user.id);
    await settleAll();

    const payment = await syncCardStatement(deps, card.id);
    expect(payment).toMatchObject({ statementBalance: 6_000, scheduledDate: "2026-04-06", dueDate: "2026-04-09" });

    clock.set("2026-04-06");
    const [paid] = await executeDuePayments(deps, user.id);
    expect(paid?.amount).toBe(6_000);
    await settleAll();

    // Next cycle: our $60 payment shows up on the card as a credit, plus a new purchase.
    await ingestCardTransaction(deps, card.id, txn("ourpayment", -6_000, "2026-04-08"));
    await ingestCardTransaction(deps, card.id, txn("c", 1_500, "2026-04-10"));
    clock.set("2026-04-16");
    const next = await deriveStatement(deps.store, card, "2026-04-16");
    expect(next).toMatchObject({ lastStatementIssueDate: "2026-04-15", lastStatementBalance: 1_500, nextPaymentDueDate: "2026-05-09" });
  });

  it("carries an unpaid remainder into the next statement", async () => {
    const { deps, clock, user, card, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, txn("a", 6_000, "2026-03-01"));
    // Checking only has $120 available; with the $100 buffer the $60 hold does not fit, so nothing is funded.
    deps.bankData = Object.assign(new MockBankDataProvider(), { getAvailableBalance: async () => 12_000 });
    await runDailySweep(deps, user.id);
    await settleAll();
    await syncCardStatement(deps, card.id);
    clock.set("2026-04-06");
    await executeDuePayments(deps, user.id); // unfunded -> stays SCHEDULED, nothing paid

    await ingestCardTransaction(deps, card.id, txn("b", 1_000, "2026-04-01"));
    const next = await deriveStatement(deps.store, card, "2026-04-16");
    expect(next?.lastStatementBalance).toBe(7_000); // 6_000 carried + 1_000 new
  });
});
