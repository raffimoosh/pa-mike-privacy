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

## Layout

```
src/
  domain/
    types.ts        Entities: User, Account, CardTransaction, Hold, Transfer, Payment, DomainEvent
    engine.ts       All business logic (ingest, sweep, schedule, pay, reconcile, overview)
    store.ts        Store interface + in-memory implementation
    money.ts        Integer-cents helpers
    dates.ts        YYYY-MM-DD date helpers (timezone-proof scheduling)
    clock.ts        Injectable clock (FixedClock for tests/demo)
  providers/
    bank-data.ts        BankDataProvider interface (transactions, balances, liabilities) + mock
    money-movement.ts   MoneyMovementProvider interface (holding account, ACH transfers) + mock
  server.ts         Fastify HTTP API (users, accounts, overview, jobs, provider webhooks, dev routes)
  demo.ts           Scripted end-to-end scenario
prisma/schema.prisma  Postgres data model matching domain/types.ts
test/engine.test.ts   Engine behaviour tests
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
npm run dev       # API on http://localhost:3000 (in-memory, mock providers)
npm run typecheck
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

- **You need a bank partner.** Holding customer funds means a sponsor bank and
  a banking-as-a-service platform (e.g. Unit, Treasury Prime, Synctera, Stripe
  Treasury, Increase). The "holding account" is an FBO (for benefit of)
  sub-account at that bank. Doing this without one is money transmission.
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

- [ ] Postgres `Store` via Prisma (schema is ready in `prisma/schema.prisma`)
- [ ] Real `BankDataProvider` (Plaid: Transactions sync + Liabilities + Balance)
- [ ] Real `MoneyMovementProvider` (partner bank: FBO accounts, ACH debit/credit, webhooks)
- [ ] Scheduler (cron / queue) that runs `runDailyJobs` per user after the morning transaction sync
- [ ] Auth, user onboarding, account linking UI (Plaid Link)
- [ ] Notifications from `DomainEvent`s (shortfall, partial payment, payment paid)
- [ ] Business-day calendar for sweep and payment timing
- [ ] Per-card settings (pay in full vs. statement minimum, exclude a card)
- [ ] Mobile/web client
