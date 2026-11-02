import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { buildDeps, type AppDeps } from "./config.js";
import {
  createUser,
  executeDuePayments,
  getOverview,
  handleTransferWebhook,
  linkAccount,
  pollCardTransactions,
  runDailyJobs,
  runDailySweep,
  syncCardStatement,
} from "./domain/engine.js";
import { mapStripeEvent, verifyStripeSignature } from "./providers/stripe/webhooks.js";

type RawBodyRequest = FastifyRequest & { rawBody?: string };

const userIdParam = z.object({ userId: z.string() });

export function buildServer(deps: AppDeps) {
  const app = Fastify({ logger: true });

  // Keep the raw JSON body so webhook signatures can be verified.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true, provider: deps.stripe ? "stripe" : "mock" }));

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
    const { userId } = userIdParam.parse(req.params);
    const body = z
      .object({
        kind: z.enum(["CHECKING", "CREDIT_CARD"]),
        providerAccountId: z.string(),
        name: z.string(),
        mask: z.string().default(""),
        providerRefs: z.record(z.string(), z.string()).optional(),
        statementSchedule: z
          .object({ closeDay: z.number().int().min(1).max(31), dueDay: z.number().int().min(1).max(31), minimumPayment: z.number().int().min(0).optional() })
          .optional(),
      })
      .parse(req.body);
    const account = await linkAccount(deps, userId, body);
    if (deps.stripe && account.kind === "CREDIT_CARD") await deps.stripe.bankData.subscribeToTransactions(account.providerAccountId);
    return account;
  });

  app.get("/users/:userId/overview", async (req) => getOverview(deps, userIdParam.parse(req.params).userId));
  app.get("/users/:userId/holds", async (req) => {
    const { userId } = userIdParam.parse(req.params);
    return deps.store.holds.list((h) => h.userId === userId);
  });
  app.get("/users/:userId/payments", async (req) => {
    const { userId } = userIdParam.parse(req.params);
    return deps.store.payments.list((p) => p.userId === userId);
  });

  // --- Jobs (a scheduler calls these once a day per user) --------------------

  app.post("/users/:userId/jobs/daily", async (req) => runDailyJobs(deps, userIdParam.parse(req.params).userId));
  app.post("/users/:userId/jobs/sweep", async (req) => (await runDailySweep(deps, userIdParam.parse(req.params).userId)) ?? { message: "nothing to sweep" });
  app.post("/users/:userId/jobs/pay", async (req) => executeDuePayments(deps, userIdParam.parse(req.params).userId));

  // --- Provider webhooks -----------------------------------------------------

  /** Stripe: ACH debit outcomes, Global Payouts outcomes, Financial Connections refreshes. */
  app.post("/webhooks/stripe", async (req, reply) => {
    const raw = (req as RawBodyRequest).rawBody ?? JSON.stringify(req.body ?? {});
    let event;
    try {
      event = deps.stripe?.webhookSecret
        ? verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, deps.stripe.webhookSecret)
        : JSON.parse(raw);
    } catch (err) {
      req.log.warn({ err }, "rejected stripe webhook");
      return reply.code(400).send({ error: "invalid signature" });
    }

    const action = mapStripeEvent(event);
    switch (action.type) {
      case "transfer": {
        const known = await deps.store.transfers.find((t) => t.providerTransferId === action.providerTransferId);
        if (!known) return { received: true, ignored: "unknown transfer" };
        await handleTransferWebhook(deps, action);
        return { received: true };
      }
      case "transactions_refreshed": {
        if (!action.succeeded) return { received: true, ignored: "refresh failed" };
        const card = await deps.store.accounts.find((a) => a.kind === "CREDIT_CARD" && a.providerAccountId === action.providerAccountId);
        if (!card) return { received: true, ignored: "unknown account" };
        const ingested = await pollCardTransactions(deps, card.id);
        const payment = await syncCardStatement(deps, card.id);
        return { received: true, ingested, payment };
      }
      case "ignore":
        return { received: true, ignored: action.eventType };
    }
  });

  /** Generic provider-shaped webhooks, kept for the mocks and for non-Stripe providers. */
  app.post("/webhooks/bank-data/transactions", async (req) => {
    const { cardAccountId } = z.object({ cardAccountId: z.string() }).parse(req.body);
    const ingested = await pollCardTransactions(deps, cardAccountId);
    const payment = await syncCardStatement(deps, cardAccountId);
    return { ingested, payment };
  });
  app.post("/webhooks/money-movement/transfers", async (req) => {
    const body = z
      .object({ providerTransferId: z.string(), status: z.enum(["SETTLED", "FAILED", "RETURNED"]), reason: z.string().optional() })
      .parse(req.body);
    return handleTransferWebhook(deps, body);
  });

  // --- Dev-only: feed the mocks (absent when real providers are configured) ---

  if (deps.mocks) {
    const { bankData, money } = deps.mocks;
    app.post("/dev/bank/balance", async (req) => {
      const body = z.object({ providerAccountId: z.string(), available: z.number().int() }).parse(req.body);
      bankData.setBalance(body.providerAccountId, body.available);
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
      bankData.pushTransactions(body.providerAccountId, body.transactions);
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
      bankData.setLiability(providerAccountId, liability);
      return { ok: true };
    });
    app.post("/dev/money/settle-all", async () => {
      const settled = money.settleAll();
      for (const t of settled) await handleTransferWebhook(deps, { providerTransferId: t.providerTransferId, status: "SETTLED" });
      return { settled: settled.length };
    });
  }

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (isMain) {
  const app = buildServer(buildDeps());
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
