import { randomUUID } from "node:crypto";
import type { Cents } from "../domain/money.js";
import type { TransferKind } from "../domain/types.js";

/**
 * Money movement provider: the partner bank / banking-as-a-service platform that
 * holds the user's FBO holding account and moves money over ACH.
 *
 * FUND     checking  -> holding   (ACH debit of the user's external checking account)
 * PAY_CARD holding   -> card      (ACH credit / bill pay to the card issuer)
 * RELEASE  holding   -> checking  (ACH credit back to the user)
 */
export interface CreateTransferRequest {
  kind: TransferKind;
  amount: Cents;
  fromProviderAccountId: string;
  toProviderAccountId: string;
  /** Our transfer id. Providers de-duplicate on this so retries are safe. */
  idempotencyKey: string;
  description: string;
}

export type ProviderTransferStatus = "PENDING" | "SETTLED";

export interface CreateTransferResult {
  providerTransferId: string;
  status: ProviderTransferStatus;
}

export interface MoneyMovementProvider {
  createHoldingAccount(userId: string): Promise<{ providerAccountId: string }>;
  createTransfer(req: CreateTransferRequest): Promise<CreateTransferResult>;
}

export interface MockTransfer extends CreateTransferRequest {
  providerTransferId: string;
  status: ProviderTransferStatus | "FAILED";
}

/**
 * In-memory mock. Transfers stay PENDING until `settle`/`settleAll` is called,
 * mirroring real ACH where settlement arrives later via webhook.
 */
export class MockMoneyMovementProvider implements MoneyMovementProvider {
  readonly transfers: MockTransfer[] = [];
  private byKey = new Map<string, MockTransfer>();

  constructor(private readonly options: { settleImmediately?: boolean } = {}) {}

  async createHoldingAccount(userId: string): Promise<{ providerAccountId: string }> {
    return { providerAccountId: `holding_${userId.slice(0, 8)}` };
  }

  async createTransfer(req: CreateTransferRequest): Promise<CreateTransferResult> {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) {
      return { providerTransferId: existing.providerTransferId, status: existing.status === "SETTLED" ? "SETTLED" : "PENDING" };
    }
    const status: ProviderTransferStatus = this.options.settleImmediately ? "SETTLED" : "PENDING";
    const t: MockTransfer = { ...req, providerTransferId: `mock_tr_${randomUUID().slice(0, 8)}`, status };
    this.transfers.push(t);
    this.byKey.set(req.idempotencyKey, t);
    return { providerTransferId: t.providerTransferId, status };
  }

  pending(): MockTransfer[] {
    return this.transfers.filter((t) => t.status === "PENDING");
  }

  /** Mark a transfer settled and return it so the caller can deliver the webhook. */
  settle(providerTransferId: string): MockTransfer {
    const t = this.transfers.find((x) => x.providerTransferId === providerTransferId);
    if (!t) throw new Error(`Unknown transfer ${providerTransferId}`);
    t.status = "SETTLED";
    return t;
  }

  fail(providerTransferId: string): MockTransfer {
    const t = this.transfers.find((x) => x.providerTransferId === providerTransferId);
    if (!t) throw new Error(`Unknown transfer ${providerTransferId}`);
    t.status = "FAILED";
    return t;
  }

  settleAll(): MockTransfer[] {
    const settled = this.pending();
    for (const t of settled) t.status = "SETTLED";
    return settled;
  }
}
