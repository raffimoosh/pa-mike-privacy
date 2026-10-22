/**
 * End-to-end walkthrough against the mocks. Run with `npm run demo`.
 * Prints what the user would see at each step.
 */
import {
  FixedClock,
  MockBankDataProvider,
  MockMoneyMovementProvider,
  createMemoryStore,
  createUser,
  formatCents,
  getOverview,
  handleTransferWebhook,
  linkAccount,
  runDailyJobs,
  type EngineDeps,
} from "./index.js";

const clock = new FixedClock("2026-03-10");
const bankData = new MockBankDataProvider();
const money = new MockMoneyMovementProvider();
const deps: EngineDeps = { store: createMemoryStore(), bankData, money, clock };

async function settleAll() {
  for (const t of money.settleAll()) await handleTransferWebhook(deps, { providerTransferId: t.providerTransferId, status: "SETTLED" });
}

async function show(label: string, userId: string) {
  const o = await getOverview(deps, userId);
  console.log(`\n== ${label} (${clock.now().toISOString().slice(0, 10)}) ==`);
  console.log(`  Holding balance: ${formatCents(o.holdingBalance)}   awaiting pull: ${formatCents(o.awaitingFunding)}   in flight: ${formatCents(o.inFlight)}`);
  for (const c of o.cards) {
    const np = c.nextPayment;
    console.log(`  ${c.account.name} ····${c.account.mask}: reserved ${formatCents(c.reserved)}` +
      (np ? ` | next payment ${formatCents(np.amount ?? np.statementBalance)} on ${np.scheduledDate} (${np.status}, due ${np.dueDate})` : ""));
  }
  for (const e of o.recentEvents.slice(0, 4).reverse()) console.log(`  · ${e.type} ${JSON.stringify(e.data)}`);
}

const user = await createUser(deps, "demo@example.com");
await linkAccount(deps, user.id, { kind: "CHECKING", providerAccountId: "chk_demo", name: "Everyday Checking", mask: "1111" });
const card = await linkAccount(deps, user.id, { kind: "CREDIT_CARD", providerAccountId: "card_demo", name: "Rewards Visa", mask: "4444" });
bankData.setBalance("chk_demo", 250_000);

// Day 1: two purchases show up on the card.
bankData.pushTransactions("card_demo", [
  { providerTxnId: "p1", amount: 4_250, pending: true, date: "2026-03-10", merchant: "Whole Foods" },
  { providerTxnId: "t2", amount: 12_000, pending: false, date: "2026-03-10", merchant: "Shell" },
]);
await runDailyJobs(deps, user.id);
await show("Day 1: purchases detected, pull from checking initiated", user.id);

// Day 2: the pull settles; the grocery auth posts with a tip added.
clock.advanceDays(1);
await settleAll();
bankData.pushTransactions("card_demo", [
  { providerTxnId: "t1", pendingTransactionId: "p1", amount: 4_750, pending: false, date: "2026-03-11", merchant: "Whole Foods" },
]);
await runDailyJobs(deps, user.id);
await show("Day 2: funds landed in holding; posted amount grew, top-up pulled", user.id);

// Day 6: statement closes. The issuer reports the balance and due date; a refund arrived too.
clock.set("2026-03-16");
await settleAll();
bankData.pushTransactions("card_demo", [
  { providerTxnId: "r1", amount: -2_000, pending: false, date: "2026-03-15", merchant: "Shell refund" },
]);
bankData.setLiability("card_demo", {
  lastStatementIssueDate: "2026-03-15",
  lastStatementBalance: 14_750, // 4_750 + 12_000 - 2_000
  minimumPaymentAmount: 3_500,
  nextPaymentDueDate: "2026-04-09",
});
await runDailyJobs(deps, user.id);
await show("Statement issued: payment scheduled 3 days before due date", user.id);

// Purchases keep coming in the new cycle.
clock.set("2026-03-20");
bankData.pushTransactions("card_demo", [{ providerTxnId: "t3", amount: 8_000, pending: false, date: "2026-03-20", merchant: "Costco" }]);
await runDailyJobs(deps, user.id);
clock.advanceDays(1);
await settleAll();
await show("New cycle purchases are held separately", user.id);

// Payment day.
clock.set("2026-04-06");
await runDailyJobs(deps, user.id);
await show("Payment day: statement paid from holding, refund excess returned to checking", user.id);
clock.advanceDays(1);
await settleAll();
await show("Payment settled", user.id);
