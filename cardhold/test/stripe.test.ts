import { describe, expect, it } from "vitest";
import {
  StripeBankDataProvider,
  StripeMoneyMovementProvider,
  encodeForm,
  mapStripeEvent,
  signStripePayload,
  verifyStripeSignature,
  type StripeHttp,
} from "../src/index.js";

/** Records calls and serves canned responses keyed by `METHOD path`. */
class FakeStripe implements StripeHttp {
  calls: Array<{ method: string; path: string; body?: unknown; query?: unknown; opts?: unknown }> = [];
  constructor(private readonly responses: Record<string, unknown | ((n: number) => unknown)>) {}
  private hits = new Map<string, number>();
  private serve(key: string) {
    const n = this.hits.get(key) ?? 0;
    this.hits.set(key, n + 1);
    const r = this.responses[key];
    if (r === undefined) throw new Error(`No canned response for ${key}`);
    return typeof r === "function" ? (r as (n: number) => unknown)(n) : r;
  }
  async get<T>(path: string, query?: Record<string, unknown>, opts?: unknown): Promise<T> {
    this.calls.push({ method: "GET", path, query, opts });
    return this.serve(`GET ${path}`) as T;
  }
  async post<T>(path: string, body?: Record<string, unknown>, opts?: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body, opts });
    return this.serve(`POST ${path}`) as T;
  }
}

describe("StripeClient form encoding", () => {
  it("encodes nested objects and arrays the way Stripe v1 expects", () => {
    expect(encodeForm({ amount: 100, features: ["transactions"], transaction_refresh: { after: "fctxnref_1" } })).toEqual([
      "amount=100",
      "features%5B0%5D=transactions",
      "transaction_refresh%5Bafter%5D=fctxnref_1",
    ]);
  });
});

describe("StripeBankDataProvider", () => {
  const account = (refresh: { id: string; status: string } | null) => ({
    id: "fca_card",
    status: "active",
    category: "credit",
    subcategory: "credit_card",
    balance: { type: "credit", cash: null, credit: { used: { usd: 12345 } } },
    transaction_refresh: refresh,
  });

  it("maps Stripe transactions into purchases and advances the cursor to the completed refresh", async () => {
    const http = new FakeStripe({
      "GET /v1/financial_connections/accounts/fca_card": account({ id: "fctxnref_2", status: "succeeded" }),
      "GET /v1/financial_connections/transactions": (n) =>
        n === 0
          ? {
              data: [
                { id: "fctxn_a", amount: -4250, status: "pending", transacted_at: 1773100800, description: "WHOLE FOODS" },
                { id: "fctxn_b", amount: 2000, status: "posted", transacted_at: 1773100800, description: "REFUND" },
              ],
              has_more: true,
            }
          : { data: [{ id: "fctxn_c", amount: -500, status: "void", transacted_at: 1773187200, description: "GONE" }], has_more: false },
    });
    const provider = new StripeBankDataProvider(http);
    const page = await provider.listCardTransactions("fca_card", "fctxnref_1");

    expect(page.cursor).toBe("fctxnref_2");
    expect(page.transactions).toEqual([
      { providerTxnId: "fctxn_a", amount: 4250, pending: true, removed: false, date: "2026-03-10", merchant: "WHOLE FOODS" },
      { providerTxnId: "fctxn_b", amount: -2000, pending: false, removed: false, date: "2026-03-10", merchant: "REFUND" },
      { providerTxnId: "fctxn_c", amount: 500, pending: false, removed: true, date: "2026-03-11", merchant: "GONE" },
    ]);
    const listCalls = http.calls.filter((c) => c.path === "/v1/financial_connections/transactions");
    expect(listCalls[0]!.query).toMatchObject({ account: "fca_card", transaction_refresh: { after: "fctxnref_1" } });
    expect(listCalls[1]!.query).toMatchObject({ starting_after: "fctxn_b" });
  });

  it("keeps the old cursor while a refresh is still pending", async () => {
    const http = new FakeStripe({
      "GET /v1/financial_connections/accounts/fca_card": account({ id: "fctxnref_9", status: "pending" }),
      "GET /v1/financial_connections/transactions": { data: [], has_more: false },
    });
    const page = await new StripeBankDataProvider(http).listCardTransactions("fca_card", "fctxnref_1");
    expect(page.cursor).toBe("fctxnref_1");
  });

  it("reads available cash balance and reports no liability data", async () => {
    const http = new FakeStripe({
      "GET /v1/financial_connections/accounts/fca_chk": {
        id: "fca_chk",
        category: "cash",
        balance: { type: "cash", cash: { available: { usd: 250_00 } } },
        transaction_refresh: null,
      },
      "POST /v1/financial_connections/accounts/fca_chk/subscribe": {},
    });
    const provider = new StripeBankDataProvider(http);
    expect(await provider.getAvailableBalance("fca_chk")).toBe(250_00);
    expect(await provider.getCardLiability("fca_chk")).toBeUndefined();
    await provider.subscribeToTransactions("fca_chk");
    expect(http.calls.at(-1)).toMatchObject({ method: "POST", body: { features: ["transactions"] } });
  });
});

describe("StripeMoneyMovementProvider", () => {
  const refs: Record<string, Record<string, string>> = {
    fca_chk: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1", stripeRecipientId: "acct_user", stripePayoutMethodId: "usba_user" },
    fca_card: { stripeRecipientId: "acct_issuer", stripePayoutMethodId: "usba_issuer" },
  };
  const make = (http: StripeHttp) =>
    new StripeMoneyMovementProvider(http, {
      financialAccountId: "fa_pool",
      statementDescriptor: "CARDHOLD",
      resolveRefs: async (id) => refs[id],
    });

  it("uses one pooled financial account as every user's holding account", async () => {
    const provider = make(new FakeStripe({}));
    expect(await provider.createHoldingAccount("user-1")).toEqual({ providerAccountId: "fa_pool" });
  });

  it("funds via an off-session ACH Direct Debit PaymentIntent with our transfer id as idempotency key", async () => {
    const http = new FakeStripe({ "POST /v1/payment_intents": { id: "pi_1", status: "processing" } });
    const result = await make(http).createTransfer({
      kind: "FUND",
      amount: 3500,
      fromProviderAccountId: "fca_chk",
      toProviderAccountId: "fa_pool",
      idempotencyKey: "transfer-123",
      description: "Card purchases set aside (2)",
    });
    expect(result).toEqual({ providerTransferId: "pi_1", status: "PENDING" });
    expect(http.calls[0]).toMatchObject({
      path: "/v1/payment_intents",
      body: { amount: 3500, currency: "usd", customer: "cus_1", payment_method: "pm_1", payment_method_types: ["us_bank_account"], confirm: true, off_session: true, statement_descriptor: "CARDHOLD" },
      opts: { idempotencyKey: "transfer-123" },
    });
  });

  it("pays the card and releases to checking with Global Payouts outbound payments over ACH", async () => {
    const http = new FakeStripe({ "POST /v2/money_management/outbound_payments": { id: "obp_1", status: "processing" } });
    const provider = make(http);
    const pay = await provider.createTransfer({ kind: "PAY_CARD", amount: 14750, fromProviderAccountId: "fa_pool", toProviderAccountId: "fca_card", idempotencyKey: "t-pay", description: "Statement" });
    const release = await provider.createTransfer({ kind: "RELEASE", amount: 2000, fromProviderAccountId: "fa_pool", toProviderAccountId: "fca_chk", idempotencyKey: "t-rel", description: "Excess" });
    expect(pay.status).toBe("PENDING");
    expect(release.providerTransferId).toBe("obp_1");
    expect(http.calls[0]!.body).toMatchObject({
      from: { financial_account: "fa_pool", currency: "usd" },
      to: { recipient: "acct_issuer", payout_method: "usba_issuer", payout_method_options: { bank_account: { preferred_networks: ["ach"] } } },
      amount: { value: 14750, currency: "usd" },
    });
    expect(http.calls[1]!.body).toMatchObject({ to: { recipient: "acct_user", payout_method: "usba_user" }, amount: { value: 2000 } });
  });

  it("refuses to debit an account without a saved payment method", async () => {
    await expect(
      make(new FakeStripe({})).createTransfer({ kind: "FUND", amount: 1, fromProviderAccountId: "fca_card", toProviderAccountId: "fa_pool", idempotencyKey: "x", description: "" }),
    ).rejects.toThrow(/no saved Stripe payment method/);
  });
});

describe("Stripe webhook mapping", () => {
  it("maps ACH debit outcomes", () => {
    expect(mapStripeEvent({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } })).toEqual({ type: "transfer", providerTransferId: "pi_1", status: "SETTLED" });
    expect(mapStripeEvent({ type: "payment_intent.payment_failed", data: { object: { id: "pi_1", last_payment_error: { message: "Insufficient funds" } } } })).toEqual({
      type: "transfer",
      providerTransferId: "pi_1",
      status: "FAILED",
      reason: "Insufficient funds",
    });
    expect(mapStripeEvent({ type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_1", reason: "insufficient_funds" } } })).toEqual({
      type: "transfer",
      providerTransferId: "pi_1",
      status: "RETURNED",
      reason: "insufficient_funds",
    });
  });

  it("maps Global Payouts thin events by type", () => {
    expect(mapStripeEvent({ type: "v2.money_management.outbound_payment.posted", related_object: { id: "obp_1", type: "v2.money_management.outbound_payment" } })).toMatchObject({ providerTransferId: "obp_1", status: "SETTLED" });
    expect(mapStripeEvent({ type: "v2.money_management.outbound_payment.returned", related_object: { id: "obp_1", type: "x" } })).toMatchObject({ status: "RETURNED" });
    expect(mapStripeEvent({ type: "v2.money_management.outbound_payment.failed", related_object: { id: "obp_1", type: "x" } })).toMatchObject({ status: "FAILED" });
  });

  it("maps transaction refreshes and ignores everything else", () => {
    expect(mapStripeEvent({ type: "financial_connections.account.refreshed_transactions", data: { object: { id: "fca_1", transaction_refresh: { status: "succeeded" } } } })).toEqual({
      type: "transactions_refreshed",
      providerAccountId: "fca_1",
      succeeded: true,
    });
    expect(mapStripeEvent({ type: "customer.created", data: { object: { id: "cus_1" } } })).toEqual({ type: "ignore", eventType: "customer.created" });
  });

  it("verifies signatures and rejects tampering or stale timestamps", () => {
    const body = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
    const secret = "whsec_test";
    const now = 1_800_000_000;
    const header = signStripePayload(body, secret, now);
    expect(verifyStripeSignature(body, header, secret, { now: () => now + 10 })).toMatchObject({ type: "payment_intent.succeeded" });
    expect(() => verifyStripeSignature(body.replace("pi_1", "pi_2"), header, secret, { now: () => now })).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(body, header, "whsec_other", { now: () => now })).toThrow(/mismatch/);
    expect(() => verifyStripeSignature(body, header, secret, { now: () => now + 1000 })).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(body, undefined, secret)).toThrow(/Missing/);
  });
});
