import type { Cents } from "../../domain/money.js";
import { toISODate } from "../../domain/dates.js";
import type { BankDataProvider, ProviderCardLiability, ProviderCardTransaction, TransactionPage } from "../bank-data.js";
import type { StripeHttp } from "./client.js";

/**
 * Stripe Financial Connections as the bank data provider.
 *
 * providerAccountId = Financial Connections account id (fca_...). The account
 * must be collected with the `balances` and `transactions` permissions and
 * subscribed to daily transaction refreshes (see `subscribeToTransactions`).
 *
 * The sync cursor is the id of the last transaction refresh we fully consumed;
 * Stripe's list endpoint accepts `transaction_refresh[after]` to return only
 * transactions that are new or changed since then.
 *
 * Not provided by Stripe: statement balance, minimum payment and due date.
 * `getCardLiability` therefore returns undefined and the engine derives the
 * statement from the card's configured schedule instead.
 */

interface FcAccount {
  id: string;
  status: "active" | "inactive" | "disconnected";
  category: "cash" | "credit" | "investment" | "other";
  subcategory: string;
  balance: null | {
    as_of: number;
    type: "cash" | "credit";
    cash?: { available: Record<string, number> | null };
    credit?: { used: Record<string, number> | null };
  };
  transaction_refresh: null | { id: string; status: "pending" | "succeeded" | "failed"; last_attempted_at: number; next_refresh_available_at: number | null };
}

interface FcTransaction {
  id: string;
  account: string;
  amount: number;
  currency: string;
  description: string;
  status: "pending" | "posted" | "void";
  transacted_at: number;
  updated: number;
}

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

export class StripeBankDataProvider implements BankDataProvider {
  constructor(private readonly http: StripeHttp) {}

  /** Call once after linking: turns on Stripe's daily refresh and kicks off the first one. */
  async subscribeToTransactions(providerAccountId: string): Promise<void> {
    await this.http.post(`/v1/financial_connections/accounts/${providerAccountId}/subscribe`, { features: ["transactions"] });
  }

  /** Ask Stripe to refresh the balance. Asynchronous; the next `getAvailableBalance` sees the result. */
  async requestBalanceRefresh(providerAccountId: string): Promise<void> {
    await this.http.post(`/v1/financial_connections/accounts/${providerAccountId}/refresh`, { features: ["balance"] });
  }

  async getAvailableBalance(providerAccountId: string): Promise<Cents> {
    const account = await this.http.get<FcAccount>(`/v1/financial_connections/accounts/${providerAccountId}`);
    return account.balance?.cash?.available?.usd ?? 0;
  }

  async listCardTransactions(providerAccountId: string, cursor?: string): Promise<TransactionPage> {
    const account = await this.http.get<FcAccount>(`/v1/financial_connections/accounts/${providerAccountId}`);
    const latest = account.transaction_refresh;
    // Only advance the cursor past a refresh that has fully completed.
    const nextCursor = latest && latest.status === "succeeded" ? latest.id : cursor ?? "";

    const transactions: ProviderCardTransaction[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await this.http.get<StripeList<FcTransaction>>("/v1/financial_connections/transactions", {
        account: providerAccountId,
        limit: 100,
        ...(cursor ? { transaction_refresh: { after: cursor } } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const t of page.data) transactions.push(mapTransaction(t, account.category));
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1]!.id;
    }
    return { transactions, cursor: nextCursor };
  }

  async getCardLiability(_providerAccountId: string): Promise<ProviderCardLiability | undefined> {
    return undefined;
  }
}

/**
 * Stripe reports money leaving the account as a negative amount (their example
 * shows a $10 ride as -1000). Our domain uses positive = purchase, so flip it.
 * Verify against sandbox data for `credit` accounts before going live.
 */
export function mapTransaction(t: FcTransaction, _category: FcAccount["category"]): ProviderCardTransaction {
  return {
    providerTxnId: t.id,
    amount: -t.amount,
    pending: t.status === "pending",
    removed: t.status === "void",
    date: toISODate(new Date(t.transacted_at * 1000)),
    merchant: t.description,
  };
}
