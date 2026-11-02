import { createMemoryStore, type Store } from "./domain/store.js";
import { systemClock } from "./domain/clock.js";
import type { EngineDeps } from "./domain/engine.js";
import { MockBankDataProvider } from "./providers/bank-data.js";
import { MockMoneyMovementProvider } from "./providers/money-movement.js";
import { StripeBankDataProvider, StripeClient, StripeMoneyMovementProvider } from "./providers/stripe/index.js";

export interface AppDeps extends EngineDeps {
  /** Present when running against the mocks; enables the /dev routes. */
  mocks?: { bankData: MockBankDataProvider; money: MockMoneyMovementProvider };
  stripe?: { bankData: StripeBankDataProvider; webhookSecret?: string };
}

/**
 * Build the dependency graph from the environment.
 * With STRIPE_SECRET_KEY set, both providers run against Stripe; otherwise the mocks.
 * The store is in-memory until the Prisma implementation lands.
 */
export function buildDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const store: Store = createMemoryStore();
  const clock = systemClock;

  if (env.STRIPE_SECRET_KEY) {
    if (!env.STRIPE_FINANCIAL_ACCOUNT_ID) throw new Error("STRIPE_FINANCIAL_ACCOUNT_ID is required with STRIPE_SECRET_KEY");
    const http = new StripeClient({ secretKey: env.STRIPE_SECRET_KEY, v2Version: env.STRIPE_V2_VERSION });
    const bankData = new StripeBankDataProvider(http);
    const money = new StripeMoneyMovementProvider(http, {
      financialAccountId: env.STRIPE_FINANCIAL_ACCOUNT_ID,
      statementDescriptor: env.STRIPE_STATEMENT_DESCRIPTOR,
      resolveRefs: async (providerAccountId) =>
        (await store.accounts.find((a) => a.providerAccountId === providerAccountId))?.providerRefs,
    });
    return { store, clock, bankData, money, stripe: { bankData, webhookSecret: env.STRIPE_WEBHOOK_SECRET } };
  }

  const bankData = new MockBankDataProvider();
  const money = new MockMoneyMovementProvider();
  return { store, clock, bankData, money, mocks: { bankData, money } };
}
