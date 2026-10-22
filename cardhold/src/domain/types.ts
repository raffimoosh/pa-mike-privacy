import type { Cents } from "./money.js";
import type { ISODate } from "./dates.js";

export interface UserSettings {
  /** Pay the card this many days before the statement due date. */
  paymentLeadDays: number;
  /** Never pull checking below this available balance. */
  checkingBuffer: Cents;
}

export interface User {
  id: string;
  email: string;
  settings: UserSettings;
  createdAt: string;
}

export type AccountKind = "CHECKING" | "CREDIT_CARD" | "HOLDING";

export interface CardStatement {
  /** Statement close / issue date. Purchases on or before this date belong to this statement. */
  issueDate: ISODate;
  balance: Cents;
  minimumPayment: Cents;
  dueDate: ISODate;
}

export interface Account {
  id: string;
  userId: string;
  kind: AccountKind;
  /** Id at the provider that owns this account (aggregator account id, or partner-bank account id for HOLDING). */
  providerAccountId: string;
  name: string;
  mask: string;
  /** Latest statement from the issuer. Credit cards only. */
  statement?: CardStatement;
  /** Aggregator sync cursor. Credit cards only. */
  syncCursor?: string;
}

export type CardTransactionStatus = "PENDING" | "POSTED" | "REMOVED";

export interface CardTransaction {
  id: string;
  userId: string;
  cardAccountId: string;
  providerTxnId: string;
  /** The pending-authorization id this posted transaction replaced, if any. */
  providerPendingTxnId?: string;
  /** Positive = purchase. Negative = credit (refund, issuer payment). */
  amount: Cents;
  status: CardTransactionStatus;
  date: ISODate;
  merchant: string;
}

/**
 * A Hold is the commitment to set aside money for one card purchase.
 * PENDING   - created, not yet pulled from checking
 * FUNDED    - money has landed in the holding account
 * APPLIED   - consumed by a card payment
 * RELEASED  - returned to checking (refund / over-hold)
 * CANCELLED - purchase disappeared before we pulled money
 */
export type HoldStatus = "PENDING" | "FUNDED" | "APPLIED" | "RELEASED" | "CANCELLED";

export interface Hold {
  id: string;
  userId: string;
  cardAccountId: string;
  cardTransactionId: string;
  amount: Cents;
  status: HoldStatus;
  txnDate: ISODate;
  /** Funding transfer (checking -> holding). */
  transferId?: string;
  /** Payment that consumed this hold. */
  paymentId?: string;
  /** Release transfer (holding -> checking). */
  releaseTransferId?: string;
  createdAt: string;
}

export type TransferKind = "FUND" | "PAY_CARD" | "RELEASE";
export type TransferStatus = "PENDING" | "SETTLED" | "FAILED" | "RETURNED";

export interface Transfer {
  id: string;
  userId: string;
  kind: TransferKind;
  amount: Cents;
  status: TransferStatus;
  fromAccountId: string;
  toAccountId: string;
  providerTransferId?: string;
  createdAt: string;
  settledAt?: string;
  failureReason?: string;
}

export type PaymentStatus = "SCHEDULED" | "INITIATED" | "PAID";

export interface Payment {
  id: string;
  userId: string;
  cardAccountId: string;
  statementIssueDate: ISODate;
  statementBalance: Cents;
  minimumPayment: Cents;
  dueDate: ISODate;
  scheduledDate: ISODate;
  status: PaymentStatus;
  /** Amount actually sent. Set when initiated. */
  amount?: Cents;
  transferId?: string;
}

export interface DomainEvent {
  id: string;
  userId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
