import type { CreateTransferRequest, CreateTransferResult, MoneyMovementProvider } from "../money-movement.js";
import type { StripeHttp } from "./client.js";

/**
 * Stripe as the money movement provider.
 *
 * Model: one pooled Treasury financial account owned by the business holds
 * every user's set-aside money; our Hold/Transfer ledger tracks who owns what.
 * (Per-user financial accounts are a Treasury-for-Platforms feature aimed at
 * business customers; a consumer product keeps one pool plus a ledger.)
 *
 *   FUND      ACH Direct Debit PaymentIntent against the user's saved
 *             us_bank_account PaymentMethod (mandate collected at link time).
 *             Settles into the Stripe balance in 2 to 4 business days.
 *   PAY_CARD  Global Payouts OutboundPayment from the financial account to a
 *             recipient that represents the card issuer's payment address.
 *   RELEASE   Global Payouts OutboundPayment back to the user's checking account.
 *
 * Every transfer is asynchronous; outcomes arrive as webhooks (see webhooks.ts).
 */

export interface StripeAccountRefs {
  /** Checking: the Customer and saved us_bank_account PaymentMethod for debits. */
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  /** Checking (release) and card (payment): Global Payouts recipient + payout method. */
  stripeRecipientId?: string;
  stripePayoutMethodId?: string;
}

export interface StripeMoneyMovementConfig {
  /** Treasury financial account (fa_...) used as the pooled holding account. */
  financialAccountId: string;
  /** Looks up the Stripe ids behind one of our provider account ids. */
  resolveRefs: (providerAccountId: string) => Promise<StripeAccountRefs | undefined>;
  statementDescriptor?: string;
}

export class StripeMoneyMovementProvider implements MoneyMovementProvider {
  constructor(
    private readonly http: StripeHttp,
    private readonly config: StripeMoneyMovementConfig,
  ) {}

  async createHoldingAccount(_userId: string): Promise<{ providerAccountId: string }> {
    return { providerAccountId: this.config.financialAccountId };
  }

  async createTransfer(req: CreateTransferRequest): Promise<CreateTransferResult> {
    switch (req.kind) {
      case "FUND":
        return this.debitChecking(req);
      case "PAY_CARD":
      case "RELEASE":
        return this.payout(req);
    }
  }

  private async debitChecking(req: CreateTransferRequest): Promise<CreateTransferResult> {
    const refs = await this.config.resolveRefs(req.fromProviderAccountId);
    if (!refs?.stripeCustomerId || !refs.stripePaymentMethodId) {
      throw new Error(`Checking account ${req.fromProviderAccountId} has no saved Stripe payment method`);
    }
    const pi = await this.http.post<{ id: string; status: string }>(
      "/v1/payment_intents",
      {
        amount: req.amount,
        currency: "usd",
        customer: refs.stripeCustomerId,
        payment_method: refs.stripePaymentMethodId,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        off_session: true,
        description: req.description,
        ...(this.config.statementDescriptor ? { statement_descriptor: this.config.statementDescriptor } : {}),
        metadata: { transfer_id: req.idempotencyKey, kind: req.kind },
      },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerTransferId: pi.id, status: pi.status === "succeeded" ? "SETTLED" : "PENDING" };
  }

  private async payout(req: CreateTransferRequest): Promise<CreateTransferResult> {
    const refs = await this.config.resolveRefs(req.toProviderAccountId);
    if (!refs?.stripeRecipientId || !refs.stripePayoutMethodId) {
      throw new Error(`Account ${req.toProviderAccountId} has no Stripe payout recipient`);
    }
    const obp = await this.http.post<{ id: string; status: string }>(
      "/v2/money_management/outbound_payments",
      {
        from: { financial_account: this.config.financialAccountId, currency: "usd" },
        to: {
          recipient: refs.stripeRecipientId,
          payout_method: refs.stripePayoutMethodId,
          payout_method_options: { bank_account: { preferred_networks: ["ach"] } },
        },
        amount: { value: req.amount, currency: "usd" },
        description: req.description,
        ...(this.config.statementDescriptor ? { statement_descriptor: this.config.statementDescriptor } : {}),
        metadata: { transfer_id: req.idempotencyKey, kind: req.kind },
      },
      { idempotencyKey: req.idempotencyKey },
    );
    return { providerTransferId: obp.id, status: obp.status === "posted" ? "SETTLED" : "PENDING" };
  }
}
