import { describe, expect, it } from "vitest";
import {
  FixedClock,
  MockBankDataProvider,
  MockMoneyMovementProvider,
  createMemoryStore,
  createUser,
  executeDuePayments,
  getOverview,
  handleTransferWebhook,
  ingestCardTransaction,
  linkAccount,
  pollCardTransactions,
  runDailySweep,
  syncCardStatement,
  type EngineDeps,
} from "../src/index.js";

async function setup(opts: { checkingAvailable?: number; buffer?: number; leadDays?: number } = {}) {
  const clock = new FixedClock("2026-03-10");
  const bankData = new MockBankDataProvider();
  const money = new MockMoneyMovementProvider();
  const deps: EngineDeps = { store: createMemoryStore(), bankData, money, clock };

  const user = await createUser(deps, "test@example.com", {
    checkingBuffer: opts.buffer ?? 10_000,
    paymentLeadDays: opts.leadDays ?? 3,
  });
  const checking = await linkAccount(deps, user.id, { kind: "CHECKING", providerAccountId: "chk_1", name: "Checking", mask: "1111" });
  const card = await linkAccount(deps, user.id, { kind: "CREDIT_CARD", providerAccountId: "card_1", name: "Rewards Visa", mask: "4444" });
  bankData.setBalance("chk_1", opts.checkingAvailable ?? 500_000);

  /** Deliver every pending mock transfer's settlement webhook. */
  async function settleAll() {
    for (const t of money.settleAll()) await handleTransferWebhook(deps, { providerTransferId: t.providerTransferId, status: "SETTLED" });
  }

  return { deps, clock, bankData, money, user, checking, card, settleAll };
}

const purchase = (id: string, amount: number, date: string, extra: Record<string, unknown> = {}) => ({
  providerTxnId: id,
  amount,
  pending: false,
  date,
  merchant: `Merchant ${id}`,
  ...extra,
});

describe("holds", () => {
  it("creates one hold per purchase and ignores credits", async () => {
    const { deps, card } = await setup();
    const a = await ingestCardTransaction(deps, card.id, purchase("t1", 4_250, "2026-03-10"));
    const b = await ingestCardTransaction(deps, card.id, purchase("t2", -1_000, "2026-03-10"));
    expect(a.hold?.amount).toBe(4_250);
    expect(a.hold?.status).toBe("PENDING");
    expect(b.hold).toBeUndefined();
    expect(await deps.store.holds.list()).toHaveLength(1);
  });

  it("is idempotent when the same update arrives twice", async () => {
    const { deps, card } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 4_250, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, purchase("t1", 4_250, "2026-03-10"));
    expect(await deps.store.holds.list()).toHaveLength(1);
    expect(await deps.store.cardTransactions.list()).toHaveLength(1);
  });

  it("updates an unfunded hold when a pending auth posts for a different amount", async () => {
    const { deps, card } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("p1", 5_000, "2026-03-10", { pending: true }));
    await ingestCardTransaction(deps, card.id, purchase("t1", 6_000, "2026-03-11", { pendingTransactionId: "p1" }));
    const holds = await deps.store.holds.list();
    expect(holds).toHaveLength(1);
    expect(holds[0]!.amount).toBe(6_000);
    const txns = await deps.store.cardTransactions.list();
    expect(txns).toHaveLength(1);
    expect(txns[0]!.providerTxnId).toBe("t1");
    expect(txns[0]!.status).toBe("POSTED");
  });

  it("creates a top-up hold when an already funded purchase grows", async () => {
    const { deps, card, user, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("p1", 5_000, "2026-03-10", { pending: true }));
    await runDailySweep(deps, user.id);
    await settleAll();
    await ingestCardTransaction(deps, card.id, purchase("t1", 5_900, "2026-03-11", { pendingTransactionId: "p1" }));
    const holds = (await deps.store.holds.list()).sort((a, b) => a.amount - b.amount);
    expect(holds.map((h) => [h.amount, h.status])).toEqual([
      [900, "PENDING"],
      [5_000, "FUNDED"],
    ]);
  });

  it("cancels the hold when an unfunded purchase is removed", async () => {
    const { deps, card } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 5_000, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, purchase("t1", 5_000, "2026-03-10", { removed: true }));
    expect((await deps.store.holds.list())[0]!.status).toBe("CANCELLED");
  });

  it("polls the provider incrementally with a cursor", async () => {
    const { deps, card, bankData } = await setup();
    bankData.pushTransactions("card_1", [purchase("t1", 1_000, "2026-03-10"), purchase("t2", 2_000, "2026-03-10")]);
    expect(await pollCardTransactions(deps, card.id)).toBe(2);
    expect(await pollCardTransactions(deps, card.id)).toBe(0);
    bankData.pushTransactions("card_1", [purchase("t3", 3_000, "2026-03-11")]);
    expect(await pollCardTransactions(deps, card.id)).toBe(1);
    expect(await deps.store.holds.list()).toHaveLength(3);
  });
});

describe("daily sweep", () => {
  it("batches all pending holds into one pull and funds them on settlement", async () => {
    const { deps, card, user, money, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 1_000, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, purchase("t2", 2_500, "2026-03-10"));

    const transfer = await runDailySweep(deps, user.id);
    expect(transfer?.kind).toBe("FUND");
    expect(transfer?.amount).toBe(3_500);
    expect(money.transfers).toHaveLength(1);
    expect(money.transfers[0]!.fromProviderAccountId).toBe("chk_1");

    let overview = await getOverview(deps, user.id);
    expect(overview.inFlight).toBe(3_500);
    expect(overview.holdingBalance).toBe(0);

    await settleAll();
    overview = await getOverview(deps, user.id);
    expect(overview.holdingBalance).toBe(3_500);
    expect(overview.cards[0]!.reserved).toBe(3_500);
    expect((await deps.store.holds.list()).every((h) => h.status === "FUNDED")).toBe(true);

    // Nothing left to sweep.
    expect(await runDailySweep(deps, user.id)).toBeUndefined();
  });

  it("respects the checking buffer, funds oldest first and retries the rest later", async () => {
    const { deps, card, user, bankData, settleAll } = await setup({ checkingAvailable: 15_000, buffer: 10_000 });
    await ingestCardTransaction(deps, card.id, purchase("t1", 3_000, "2026-03-09"));
    await ingestCardTransaction(deps, card.id, purchase("t2", 4_000, "2026-03-10"));

    const first = await runDailySweep(deps, user.id);
    expect(first?.amount).toBe(3_000);
    const shortfall = await deps.store.events.find((e) => e.type === "sweep.shortfall");
    expect(shortfall?.data.skippedAmount).toBe(4_000);

    bankData.setBalance("chk_1", 50_000);
    const second = await runDailySweep(deps, user.id);
    expect(second?.amount).toBe(4_000);
    await settleAll();
    expect((await getOverview(deps, user.id)).holdingBalance).toBe(7_000);
  });

  it("puts holds back in the queue when the pull fails", async () => {
    const { deps, card, user, money } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 3_000, "2026-03-10"));
    const transfer = await runDailySweep(deps, user.id);
    const failed = money.fail(transfer!.providerTransferId!);
    await handleTransferWebhook(deps, { providerTransferId: failed.providerTransferId, status: "FAILED", reason: "R01 insufficient funds" });

    const hold = (await deps.store.holds.list())[0]!;
    expect(hold.status).toBe("PENDING");
    expect(hold.transferId).toBeUndefined();
    expect((await deps.store.transfers.get(transfer!.id))?.status).toBe("FAILED");

    const retry = await runDailySweep(deps, user.id);
    expect(retry?.amount).toBe(3_000);
  });
});

describe("statements and payments", () => {
  const statement = { lastStatementIssueDate: "2026-03-15", lastStatementBalance: 6_000, minimumPaymentAmount: 2_500, nextPaymentDueDate: "2026-04-09" };

  it("schedules one payment per statement, lead days before the due date", async () => {
    const { deps, card, bankData } = await setup({ leadDays: 3 });
    bankData.setLiability("card_1", statement);
    const payment = await syncCardStatement(deps, card.id);
    expect(payment?.scheduledDate).toBe("2026-04-06");
    expect(payment?.statementBalance).toBe(6_000);
    expect(await syncCardStatement(deps, card.id)).toMatchObject({ id: payment!.id });
    expect(await deps.store.payments.list()).toHaveLength(1);
  });

  it("never schedules in the past", async () => {
    const { deps, card, bankData, clock } = await setup({ leadDays: 3 });
    clock.set("2026-04-08");
    bankData.setLiability("card_1", statement);
    expect((await syncCardStatement(deps, card.id))?.scheduledDate).toBe("2026-04-08");
  });

  it("pays the statement from that cycle's holds and leaves newer holds reserved", async () => {
    const { deps, card, user, bankData, clock, money, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 4_000, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, purchase("t2", 2_000, "2026-03-14"));
    await ingestCardTransaction(deps, card.id, purchase("t3", 9_000, "2026-03-20")); // next cycle
    await runDailySweep(deps, user.id);
    await settleAll();

    bankData.setLiability("card_1", statement);
    await syncCardStatement(deps, card.id);

    clock.set("2026-04-05");
    expect(await executeDuePayments(deps, user.id)).toHaveLength(0);

    clock.set("2026-04-06");
    const [payment] = await executeDuePayments(deps, user.id);
    expect(payment?.status).toBe("INITIATED");
    expect(payment?.amount).toBe(6_000);
    const pay = money.transfers.find((t) => t.kind === "PAY_CARD")!;
    expect(pay.toProviderAccountId).toBe("card_1");
    expect(money.transfers.filter((t) => t.kind === "RELEASE")).toHaveLength(0);

    await settleAll();
    const holds = await deps.store.holds.list();
    expect(holds.find((h) => h.amount === 9_000)?.status).toBe("FUNDED");
    expect(holds.filter((h) => h.status === "APPLIED").map((h) => h.amount).sort()).toEqual([2_000, 4_000]);
    expect((await deps.store.payments.list())[0]!.status).toBe("PAID");

    const overview = await getOverview(deps, user.id);
    expect(overview.holdingBalance).toBe(9_000);
    expect(overview.cards[0]!.reserved).toBe(9_000);
  });

  it("releases over-held money back to checking when a refund lowers the statement", async () => {
    const { deps, card, user, bankData, clock, money, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 4_000, "2026-03-10"));
    await ingestCardTransaction(deps, card.id, purchase("t2", 2_000, "2026-03-14"));
    await ingestCardTransaction(deps, card.id, purchase("r1", -1_500, "2026-03-15")); // refund
    await runDailySweep(deps, user.id);
    await settleAll();

    bankData.setLiability("card_1", { ...statement, lastStatementBalance: 4_500 });
    await syncCardStatement(deps, card.id);
    clock.set("2026-04-06");
    const [payment] = await executeDuePayments(deps, user.id);
    expect(payment?.amount).toBe(4_500);

    const release = money.transfers.find((t) => t.kind === "RELEASE")!;
    expect(release.amount).toBe(1_500);
    expect(release.toProviderAccountId).toBe("chk_1");

    await settleAll();
    const holds = (await deps.store.holds.list()).sort((a, b) => a.amount - b.amount);
    // t2 was split: 500 applied, 1500 released.
    expect(holds.map((h) => [h.amount, h.status])).toEqual([
      [500, "APPLIED"],
      [1_500, "RELEASED"],
      [4_000, "APPLIED"],
    ]);
    expect((await getOverview(deps, user.id)).holdingBalance).toBe(0);
  });

  it("pays what is funded and flags the shortfall when holds do not cover the statement", async () => {
    const { deps, card, user, bankData, clock, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 2_000, "2026-03-10"));
    await runDailySweep(deps, user.id);
    await settleAll();
    bankData.setLiability("card_1", statement); // 6_000 owed, 2_000 held
    await syncCardStatement(deps, card.id);
    clock.set("2026-04-06");
    const [payment] = await executeDuePayments(deps, user.id);
    expect(payment?.amount).toBe(2_000);
    const partial = await deps.store.events.find((e) => e.type === "payment.partial");
    expect(partial?.data).toMatchObject({ shortfall: 4_000, belowMinimum: true });
  });

  it("re-schedules the payment and frees the holds when the card payment fails", async () => {
    const { deps, card, user, bankData, clock, money, settleAll } = await setup();
    await ingestCardTransaction(deps, card.id, purchase("t1", 6_000, "2026-03-10"));
    await runDailySweep(deps, user.id);
    await settleAll();
    bankData.setLiability("card_1", statement);
    await syncCardStatement(deps, card.id);
    clock.set("2026-04-06");
    await executeDuePayments(deps, user.id);
    const pay = money.fail(money.transfers.find((t) => t.kind === "PAY_CARD")!.providerTransferId);
    await handleTransferWebhook(deps, { providerTransferId: pay.providerTransferId, status: "FAILED", reason: "issuer rejected" });

    const payment = (await deps.store.payments.list())[0]!;
    expect(payment.status).toBe("SCHEDULED");
    expect(payment.transferId).toBeUndefined();
    const hold = (await deps.store.holds.list())[0]!;
    expect(hold.status).toBe("FUNDED");
    expect(hold.paymentId).toBeUndefined();

    // Next day it tries again.
    clock.set("2026-04-07");
    const [retry] = await executeDuePayments(deps, user.id);
    expect(retry?.amount).toBe(6_000);
  });
});
