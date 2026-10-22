import type { Cents } from "../domain/money.js";
import type { ISODate } from "../domain/dates.js";

/**
 * Bank data provider: read-only view of the user's existing accounts
 * (an aggregator such as Plaid, MX or Finicity). Supplies card transactions,
 * checking balances and credit card statement/liability data.
 */
export interface ProviderCardTransaction {
  providerTxnId: string;
  /** For a posted transaction, the id of the pending authorization it replaces. */
  pendingTransactionId?: string;
  /** Positive = purchase, negative = credit. Integer cents. */
  amount: Cents;
  pending: boolean;
  date: ISODate;
  merchant: string;
  /** True when the provider says this transaction no longer exists. */
  removed?: boolean;
}

export interface ProviderCardLiability {
  lastStatementIssueDate: ISODate;
  lastStatementBalance: Cents;
  minimumPaymentAmount: Cents;
  nextPaymentDueDate: ISODate;
}

export interface TransactionPage {
  transactions: ProviderCardTransaction[];
  cursor: string;
}

export interface BankDataProvider {
  getAvailableBalance(providerAccountId: string): Promise<Cents>;
  /** Incremental sync: returns transactions added/changed since `cursor`. */
  listCardTransactions(providerAccountId: string, cursor?: string): Promise<TransactionPage>;
  getCardLiability(providerAccountId: string): Promise<ProviderCardLiability | undefined>;
}

/** In-memory mock. Tests and the dev server push data into it directly. */
export class MockBankDataProvider implements BankDataProvider {
  private balances = new Map<string, Cents>();
  private transactions = new Map<string, ProviderCardTransaction[]>();
  private liabilities = new Map<string, ProviderCardLiability>();

  setBalance(providerAccountId: string, available: Cents): void {
    this.balances.set(providerAccountId, available);
  }

  /** Append transaction updates. The same providerTxnId may appear again with new values. */
  pushTransactions(providerAccountId: string, txns: ProviderCardTransaction[]): void {
    const list = this.transactions.get(providerAccountId) ?? [];
    list.push(...txns);
    this.transactions.set(providerAccountId, list);
  }

  setLiability(providerAccountId: string, liability: ProviderCardLiability): void {
    this.liabilities.set(providerAccountId, liability);
  }

  async getAvailableBalance(providerAccountId: string): Promise<Cents> {
    return this.balances.get(providerAccountId) ?? 0;
  }

  async listCardTransactions(providerAccountId: string, cursor?: string): Promise<TransactionPage> {
    const list = this.transactions.get(providerAccountId) ?? [];
    const start = cursor ? Number(cursor) : 0;
    return { transactions: list.slice(start), cursor: String(list.length) };
  }

  async getCardLiability(providerAccountId: string): Promise<ProviderCardLiability | undefined> {
    return this.liabilities.get(providerAccountId);
  }
}
