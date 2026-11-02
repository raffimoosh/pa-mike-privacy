/**
 * Tiny Stripe HTTP client. We call the documented endpoints directly instead of
 * depending on the SDK because the money-management (v2) APIs are preview and
 * move faster than SDK releases. v1 endpoints take form-encoded bodies; v2
 * endpoints take JSON and require an explicit Stripe-Version header.
 */
export interface StripeRequestOptions {
  idempotencyKey?: string;
  /** Stripe-Context header (v2 recipient-scoped calls). */
  context?: string;
}

export interface StripeHttp {
  get<T = unknown>(path: string, query?: Record<string, unknown>, opts?: StripeRequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: Record<string, unknown>, opts?: StripeRequestOptions): Promise<T>;
}

export interface StripeClientConfig {
  secretKey: string;
  /** Version header for v2 (money management) calls. */
  v2Version?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_V2_VERSION = "2026-10-28.endive";

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Stripe API error ${status}: ${JSON.stringify(body)}`);
  }
}

/** Stripe's form encoding: nested objects become a[b][c]=v, arrays a[0]=v. */
export function encodeForm(value: unknown, prefix = "", out: string[] = []): string[] {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => encodeForm(v, `${prefix}[${i}]`, out));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      encodeForm(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

export class StripeClient implements StripeHttp {
  private readonly baseUrl: string;
  private readonly v2Version: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: StripeClientConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.stripe.com";
    this.v2Version = config.v2Version ?? DEFAULT_V2_VERSION;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async get<T>(path: string, query?: Record<string, unknown>, opts: StripeRequestOptions = {}): Promise<T> {
    const qs = query ? encodeForm(query).join("&") : "";
    return this.request<T>("GET", qs ? `${path}?${qs}` : path, undefined, opts);
  }

  async post<T>(path: string, body: Record<string, unknown> = {}, opts: StripeRequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  private async request<T>(method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, opts: StripeRequestOptions): Promise<T> {
    const isV2 = path.startsWith("/v2/");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.secretKey}` };
    if (isV2) headers["Stripe-Version"] = this.v2Version;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (opts.context) headers["Stripe-Context"] = opts.context;

    let payload: string | undefined;
    if (method === "POST") {
      if (isV2) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body ?? {});
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        payload = encodeForm(body ?? {}).join("&");
      }
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new StripeApiError(res.status, json);
    return json as T;
  }
}
