import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Translate Stripe webhook events into the two things the engine cares about:
 * transfer outcomes and "this card has new transactions".
 *
 * v1 events carry the full object; v2 money-management events are thin and
 * only identify the object, so the outcome comes from the event type.
 */
export type StripeWebhookAction =
  | { type: "transfer"; providerTransferId: string; status: "SETTLED" | "FAILED" | "RETURNED"; reason?: string }
  | { type: "transactions_refreshed"; providerAccountId: string; succeeded: boolean }
  | { type: "ignore"; eventType: string };

interface StripeEventShape {
  type: string;
  data?: { object?: Record<string, unknown> };
  related_object?: { id: string; type: string };
}

export function mapStripeEvent(event: StripeEventShape): StripeWebhookAction {
  const obj = (event.data?.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    // --- ACH Direct Debit (FUND) ---
    case "payment_intent.succeeded":
      return { type: "transfer", providerTransferId: String(obj.id), status: "SETTLED" };
    case "payment_intent.payment_failed": {
      const err = obj.last_payment_error as { message?: string; code?: string } | undefined;
      return { type: "transfer", providerTransferId: String(obj.id), status: "FAILED", reason: err?.message ?? err?.code ?? "payment_failed" };
    }
    case "charge.dispute.created": {
      // An ACH return after the PaymentIntent already succeeded (R01 etc.) surfaces as a dispute.
      const pi = obj.payment_intent;
      if (typeof pi !== "string") return { type: "ignore", eventType: event.type };
      return { type: "transfer", providerTransferId: pi, status: "RETURNED", reason: String(obj.reason ?? "ach_return") };
    }

    // --- Global Payouts (PAY_CARD / RELEASE) ---
    case "v2.money_management.outbound_payment.posted":
      return { type: "transfer", providerTransferId: relatedId(event), status: "SETTLED" };
    case "v2.money_management.outbound_payment.failed":
      return { type: "transfer", providerTransferId: relatedId(event), status: "FAILED", reason: "outbound_payment_failed" };
    case "v2.money_management.outbound_payment.returned":
      return { type: "transfer", providerTransferId: relatedId(event), status: "RETURNED", reason: "outbound_payment_returned" };

    // --- Financial Connections (card transactions) ---
    case "financial_connections.account.refreshed_transactions": {
      const refresh = obj.transaction_refresh as { status?: string } | undefined;
      return { type: "transactions_refreshed", providerAccountId: String(obj.id), succeeded: refresh?.status === "succeeded" };
    }

    default:
      return { type: "ignore", eventType: event.type };
  }
}

function relatedId(event: StripeEventShape): string {
  if (!event.related_object?.id) throw new Error(`Event ${event.type} has no related_object`);
  return event.related_object.id;
}

/**
 * Verify a Stripe-Signature header (format `t=<ts>,v1=<hex>[,v1=...]`).
 * Returns the parsed event or throws.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  signingSecret: string,
  opts: { toleranceSeconds?: number; now?: () => number } = {},
): StripeEventShape {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, ...rest] = kv.split("=");
      return [k!.trim(), rest.join("=")];
    }),
  ) as Record<string, string>;
  const timestamp = parts.t;
  const signatures = signatureHeader
    .split(",")
    .filter((kv) => kv.trim().startsWith("v1="))
    .map((kv) => kv.trim().slice(3));
  if (!timestamp || signatures.length === 0) throw new Error("Malformed Stripe-Signature header");

  const expected = createHmac("sha256", signingSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const ok = signatures.some((s) => {
    const buf = Buffer.from(s, "hex");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  if (!ok) throw new Error("Stripe signature mismatch");

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) throw new Error("Stripe signature timestamp outside tolerance");

  return JSON.parse(rawBody) as StripeEventShape;
}

/** Build a Stripe-Signature header. Used by tests and the dev simulator. */
export function signStripePayload(rawBody: string, signingSecret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", signingSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
