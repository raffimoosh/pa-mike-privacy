import Fastify from "fastify";
import { z } from "zod";
import {
  MockBankDataProvider,
  MockMoneyMovementProvider,
  createMemoryStore,
  createUser,
  executeDuePayments,
  getOverview,
  handleTransferWebhook,
  linkAccount,
  pollCardTransactions,
  runDailyJobs,
  runDailySweep,
  syncCardStatement,
  systemClock,
  type EngineDeps,
} from "./index.js";

/**
 * HTTP API. Runs against the in-memory store and mock providers today; the
 * `/dev/*` routes exist only to simulate what Plaid / the partner bank would
 * send and must be removed (or auth-gated) before this talks to real money.
 */
export function buildServer(deps: EngineDeps & { bankData: MockBankDataProvider; money: MockMoneyMovementProvider }) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true }));

  // --- Users and accounts ---------------------------------------------------

  app.post("/users", async (req) => {
    const body = z
      .object({
        email: z.string().email(),
        settings: z.object({ paymentLeadDays: z.number().int().min(0).max(20), checkingBuffer: z.number().int().min(0) }).partial().optional(),
      })
      .parse(req.body);
    return createUser(deps, body.email, body.settings);
  });

  app.post("/users/:userId/accounts", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    const body = z
      .object({
        kind: z.enum(["CHECKING", "CREDIT_CARD"]),
        providerAccountId: z.string(),
        name: z.string(),
        mask: z.string().default(""),
      })
      .parse(req.body);
    return linkAccount(deps, userId, body);
  });

  app.get("/users/:userId/overview", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return getOverview(deps, userId);
  });

  app.get("/users/:userId/holds", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return deps.store.holds.list((h) => h.userId === userId);
  });

  app.get("/users/:userId/payments", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return deps.store.payments.list((p) => p.userId === userId);
  });

  // --- Jobs (a scheduler calls these once a day per user) --------------------

  app.post("/users/:userId/jobs/daily", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return runDailyJobs(deps, userId);
  });
  app.post("/users/:userId/jobs/sweep", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return (await runDailySweep(deps, userId)) ?? { message: "nothing to sweep" };
  });
  app.post("/users/:userId/jobs/pay", async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return executeDuePayments(deps, userId);
  });

  // --- Provider webhooks -----------------------------------------------------

  /** Bank data provider says a card has new transaction updates. */
  app.post("/webhooks/bank-data/transactions", async (req) => {
    const { cardAccountId } = z.object({ cardAccountId: z.string() }).parse(req.body);
    const ingested = await pollCardTransactions(deps, cardAccountId);
    const payment = await syncCardStatement(deps, cardAccountId);
    return { ingested, payment };
  });

  /** Money movement provider reports a transfer outcome. */
  app.post("/webhooks/money-movement/transfers", async (req) => {
    const body = z
      .object({ providerTransferId: z.string(), status: z.enum(["SETTLED", "FAILED", "RETURNED"]), reason: z.string().optional() })
      .parse(req.body);
    return handleTransferWebhook(deps, body);
  });

  // --- Dev-only: feed the mocks ---------------------------------------------

  app.post("/dev/bank/balance", async (req) => {
    const body = z.object({ providerAccountId: z.string(), available: z.number().int() }).parse(req.body);
    deps.bankData.setBalance(body.providerAccountId, body.available);
    return { ok: true };
  });

  app.post("/dev/bank/transactions", async (req) => {
    const body = z
      .object({
        providerAccountId: z.string(),
        transactions: z.array(
          z.object({
            providerTxnId: z.string(),
            pendingTransactionId: z.string().optional(),
            amount: z.number().int(),
            pending: z.boolean().default(false),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            merchant: z.string(),
            removed: z.boolean().optional(),
          }),
        ),
      })
      .parse(req.body);
    deps.bankData.pushTransactions(body.providerAccountId, body.transactions);
    return { queued: body.transactions.length };
  });

  app.post("/dev/bank/liability", async (req) => {
    const body = z
      .object({
        providerAccountId: z.string(),
        lastStatementIssueDate: z.string(),
        lastStatementBalance: z.number().int(),
        minimumPaymentAmount: z.number().int(),
        nextPaymentDueDate: z.string(),
      })
      .parse(req.body);
    const { providerAccountId, ...liability } = body;
    deps.bankData.setLiability(providerAccountId, liability);
    return { ok: true };
  });

  /** Settle every pending mock transfer and deliver the webhooks, as the partner bank would. */
  app.post("/dev/money/settle-all", async () => {
    const settled = deps.money.settleAll();
    for (const t of settled) await handleTransferWebhook(deps, { providerTransferId: t.providerTransferId, status: "SETTLED" });
    return { settled: settled.length };
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (isMain) {
  const deps = {
    store: createMemoryStore(),
    bankData: new MockBankDataProvider(),
    money: new MockMoneyMovementProvider(),
    clock: systemClock,
  };
  const app = buildServer(deps);
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
