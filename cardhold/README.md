# cardhold

Use a credit card like a debit card. Every purchase on a linked credit card is
matched by a pull of the same amount from the user's checking account into a
holding account. A few days before the statement due date, the holding account
pays the card in full. The user keeps the card's rewards and fraud protection,
but can never spend money they don't have, and never carries a balance.

`cardhold` is a working codename; rename freely.

## How it works

```
 Card purchase ──▶ Hold (PENDING) ──▶ daily sweep: one ACH pull ──▶ Hold (FUNDED)
   (via bank data        │             checking ──▶ holding               │
    provider)            │                                                │
                         └── purchase removed ──▶ CANCELLED               │
                                                                          ▼
 Statement issued ──▶ Payment (SCHEDULED for due date − lead days) ──▶ payment day
   (balance, min,                                                         │
    due date)                      ┌──────────────────────────────────────┤
                                   ▼                                      ▼
                  holding ──▶ card issuer (PAY_CARD)         excess ──▶ checking (RELEASE)
                  holds for that cycle → APPLIED             (refunds, corrections) → RELEASED
```

1. **Detect.** The bank data provider (Plaid-style aggregator) reports card
   transactions. Each purchase creates a `Hold` for its amount. Pending
   authorizations that later post for a different amount adjust the hold
   (or create a top-up if the money was already pulled). Credits/refunds never
   create holds.
2. **Sweep.** Once a day all unfunded holds are batched into one ACH pull from
   checking into the holding account. The pull never takes checking below the
   user's configured buffer; holds that don't fit wait for the next day and the
   user is notified (`sweep.shortfall`).
3. **Schedule.** When the issuer publishes a statement (balance, minimum
   payment, due date), a `Payment` is scheduled for `dueDate − paymentLeadDays`.
4. **Pay.** On the scheduled day the app pays `min(statement balance, funded
   holds dated on or before the statement close)` from holding to the card.
   Holds are consumed oldest-first (split if needed). Money held for that cycle
   beyond the statement balance, which is what a refund looks like, is sent
   back to checking. Holds for purchases after the statement close stay
   reserved for the next cycle.
5. **Reconcile.** Transfer webhooks (settled / failed / returned) drive hold and
   payment state. A failed pull puts holds back in the queue; a failed card
   payment re-schedules and frees the holds.

Refunds are deliberately **not** matched to purchases. Aggregators don't link
them reliably, and the issuer's statement balance already reflects them, so the
cycle-level "pay the statement, release the rest" rule handles refunds, partial
refunds, disputes and amount corrections with one mechanism.

## Stripe integration

Stripe is the chosen provider. The mapping, and what each piece needs from Stripe:

| Engine step | Stripe product | Notes |
| --- | --- | --- |
| Detect card purchases | **Financial Connections** transactions | Link the card with `transactions` permission, subscribe to daily refreshes. Stripe sends `financial_connections.account.refreshed_transactions`; we list with `transaction_refresh[after]=<cursor>`. |
| Checking balance | Financial Connections balances | `balance.cash.available.usd` on the linked checking account. |
| Statement balance, due date, minimum | **Not available from Stripe** | The user enters the card's close day and due day once (`statementSchedule`); we derive the statement from the transactions we hold (`src/domain/statement.ts`). Plaid Liabilities could replace this later. |
| Pull from checking (FUND) | **ACH Direct Debit** PaymentIntent | Saved `us_bank_account` PaymentMethod + mandate from a SetupIntent at link time. Settles T+4 (T+2 if enabled). Outcomes: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.dispute.created` (late ACH return). |
| Holding account | **Treasury** financial account | One pooled financial account owned by the business; our Hold/Transfer ledger tracks each user's share. |
| Pay the card (PAY_CARD) | **Global Payouts** OutboundPayment over ACH | The issuer is a Global Payouts recipient (v2 Account + PayoutMethod with the issuer's ACH payment address). Outcomes: `v2.money_management.outbound_payment.posted/failed/returned`. |
| Return excess (RELEASE) | Global Payouts OutboundPayment | The user is a recipient; their checking account is the PayoutMethod. |

Code: `src/providers/stripe/` (HTTP client, both providers, webhook mapping and
signature verification). `src/config.ts` switches from the mocks to Stripe when
`STRIPE_SECRET_KEY` is set; `/webhooks/stripe` is the single endpoint to
register in the Stripe Dashboard.

Per-account Stripe ids live in `Account.providerRefs`:

| Account | Keys |
| --- | --- |
| CHECKING | `stripeCustomerId`, `stripePaymentMethodId` (debits), `stripeRecipientId`, `stripePayoutMethodId` (releases) |
| CREDIT_CARD | `stripeRecipientId`, `stripePayoutMethodId` (payments to the issuer) |

### Open questions for Stripe before going live

1. **Licensing.** Stripe's own guidance says Global Payouts "is best for
   businesses that already hold the licenses required to move money
   themselves." Sending consumers' money to third parties (card issuers) is
   money transmission in most US states. Confirm with Stripe and counsel whether
   Treasury's sponsor-bank arrangement covers this flow or whether we need
   licences or a different structure.
2. **Funding the financial account from ACH debits.** ACH Direct Debit settles
   into the Stripe payments balance; Global Payouts sends from a `storage`
   financial account. Stripe documents funding that account from an external
   bank account; the `payments`-type financial account that would link the two
   is in private preview. Ask Stripe for the supported path.
3. **Issuer payment addresses.** Confirm each target issuer accepts ACH credits
   to a routing/account pair for card payments, and what the account number
   format is (usually the card number).
4. **Credit-card transaction sign convention.** We flip Stripe's `amount`
   (negative = money out). Verify against sandbox data for `credit` accounts.
5. **Treasury and Financial Connections activation.** Both need application
   and live-mode registration in the Dashboard.

## Layout

```
src/
  domain/
    types.ts        Entities: User, Account, CardTransaction, Hold, Transfer, Payment, DomainEvent
    engine.ts       All business logic (ingest, sweep, schedule, pay, reconcile, overview)
    statement.ts    Derives a statement from transactions when the provider has no issuer data
    store.ts        Store interface + in-memory implementation
    money.ts        Integer-cents helpers
    dates.ts        YYYY-MM-DD date helpers (timezone-proof scheduling)
    clock.ts        Injectable clock (FixedClock for tests/demo)
  providers/
    bank-data.ts        BankDataProvider interface (transactions, balances, liabilities) + mock
    money-movement.ts   MoneyMovementProvider interface (holding account, ACH transfers) + mock
    stripe/             Stripe implementations: client, bank-data, money-movement, webhooks
  config.ts         Builds deps from env (Stripe or mocks)
  server.ts         Fastify HTTP API (users, accounts, overview, jobs, webhooks, dev routes)
  demo.ts           Scripted end-to-end scenario
prisma/schema.prisma  Postgres data model matching domain/types.ts
test/                 Engine, statement and Stripe provider tests
```

The engine is pure TypeScript over three injected ports: `Store`,
`BankDataProvider`, `MoneyMovementProvider`. Everything runs today against the
in-memory store and the mocks; swapping in Postgres and real providers does not
touch the engine.

## Running it

```bash
cd cardhold
npm install
npm test          # engine tests
npm run demo      # scripted walkthrough with printed state at each step
npm run dev       # API on http://localhost:3000 (in-memory store; mocks unless STRIPE_SECRET_KEY is set)
npm run typecheck
```

With Stripe (sandbox keys work for every API used here):

```bash
cp .env.example .env   # fill STRIPE_SECRET_KEY, STRIPE_FINANCIAL_ACCOUNT_ID, STRIPE_WEBHOOK_SECRET
stripe listen --forward-to localhost:3000/webhooks/stripe
npm run dev
```

Quick API tour (see `src/server.ts` for the full list):

```bash
curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"me@example.com"}'
curl -X POST localhost:3000/users/$USER/accounts -H 'content-type: application/json' \
  -d '{"kind":"CHECKING","providerAccountId":"chk_1","name":"Checking","mask":"1111"}'
curl -X POST localhost:3000/users/$USER/accounts -H 'content-type: application/json' \
  -d '{"kind":"CREDIT_CARD","providerAccountId":"card_1","name":"Visa","mask":"4444"}'
# feed the mock bank, then run the daily job
curl -X POST localhost:3000/dev/bank/balance -H 'content-type: application/json' -d '{"providerAccountId":"chk_1","available":100000}'
curl -X POST localhost:3000/dev/bank/transactions -H 'content-type: application/json' \
  -d '{"providerAccountId":"card_1","transactions":[{"providerTxnId":"t1","amount":2599,"date":"2026-10-22","merchant":"Coffee"}]}'
curl -X POST localhost:3000/users/$USER/jobs/daily
curl -X POST localhost:3000/dev/money/settle-all
curl localhost:3000/users/$USER/overview
```

All amounts are integer cents. Dates are `YYYY-MM-DD` strings.

## Design decisions

- **Daily batch, not per-transaction pulls.** One ACH debit per day per user
  keeps provider fees and user-visible bank activity sane. The hold is created
  the moment the purchase is seen, so the user's "available to spend" view is
  live even though money moves once a day. A per-transaction mode could be
  added later behind a user setting.
- **Pay the statement, not the sum of holds.** The issuer's statement is the
  source of truth for what is owed. Holds decide how much we *can* pay. Paying
  less than the statement raises `payment.partial` (and flags if it's under
  the minimum payment) so the user can top up.
- **Idempotent everywhere.** Transaction ingestion de-duplicates on the
  provider id; transfers carry our id as the provider idempotency key; webhook
  handlers tolerate redelivery.
- **Event log.** Every state change emits a `DomainEvent`. That becomes the
  notification feed and the audit trail.

## Things to know before this touches real money

- **Stripe Treasury is the bank partner.** The pooled financial account is an
  FBO (for benefit of) arrangement at Fifth Third Bank administered by Stripe.
  Whether that covers paying third parties on consumers' behalf is open
  question 1 above.
- **ACH is slow and reversible.** Pulls take 1 to 3 business days to settle and
  can be returned (R01 insufficient funds, R10 unauthorized) for up to 60 days.
  Schedule the card payment far enough ahead of the due date to absorb that;
  `paymentLeadDays` defaults to 3 calendar days, which is tight. Use business
  days once you have a holiday calendar.
- **Aggregator latency.** Plaid-style transaction data typically lags the
  purchase by hours to a day and pending/posted amounts differ (tips, FX,
  hotels). The engine handles amount changes and removals; expect them.
- **Paying the card.** Issuers accept ACH credits to the card account, but
  some need the card number rather than an ACH routing/account pair. Bill pay
  rails or the issuer's own payment API may be required per issuer.
- **Reg E / consumer disclosures.** Pulling from a consumer's checking account
  requires written ACH authorization, clear disclosures, and a way to revoke.
- **Statement timing edge.** A purchase pending at statement close but posting
  after it may land on the next statement while its hold is dated in this one.
  The "release excess" rule returns that money and the next cycle picks it up
  again, which is correct but produces a visible round trip.

## Roadmap

- [x] Stripe `BankDataProvider` (Financial Connections) and `MoneyMovementProvider` (ACH debit, Global Payouts)
- [x] Derived statements from a user-entered cycle (Stripe has no liabilities data)
- [ ] Run the Stripe sandbox end to end: link a test card and checking account, confirm the transaction sign convention, settle a debit, send a payout
- [ ] Onboarding flow: Financial Connections session with `transactions` + `balances` + `payment_method`, SetupIntent for the ACH mandate, Global Payouts recipient for the user, issuer recipients
- [ ] Resolve the Stripe open questions above (licensing, funding path, issuer ACH addresses)
- [ ] Postgres `Store` via Prisma (schema is ready in `prisma/schema.prisma`)
- [ ] Scheduler (cron / queue) that runs `runDailyJobs` per user after the morning transaction refresh
- [ ] Auth and user onboarding UI
- [ ] Notifications from `DomainEvent`s (shortfall, partial payment, payment paid)
- [ ] Business-day calendar for sweep and payment timing
- [ ] Per-card settings (pay in full vs. statement minimum, exclude a card)
- [ ] Mobile/web client
