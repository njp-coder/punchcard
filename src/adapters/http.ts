/**
 * Shared HTTP for adapters: throttling, 429 backoff, and honest errors.
 *
 * Rate limits are wildly uneven across destinations — a new free Clockify
 * workspace allows about thirty requests *per hour* for the whole workspace,
 * while a paid one allows fifty per second. So we never hardcode a budget: we
 * throttle to a configured floor and adapt to whatever the server tells us.
 */

export interface HttpOptions {
  baseUrl: string;
  headers: Record<string, string>;
  /** Minimum gap between requests, ms. */
  minIntervalMs?: number;
  /** Give up after this many attempts on a retryable failure. */
  maxRetries?: number;
  onThrottle?: (waitMs: number, reason: string) => void;
}

export class HttpError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class HttpClient {
  private lastRequestAt = 0;
  private readonly minInterval: number;
  private readonly maxRetries: number;

  constructor(private readonly options: HttpOptions) {
    this.minInterval = options.minIntervalMs ?? 100;
    this.maxRetries = options.maxRetries ?? 5;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.options.baseUrl}${path}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.waitForSlot();

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'punchcard (+https://github.com/punchcard-dev/punchcard)',
          ...this.options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      this.lastRequestAt = Date.now();

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const text = await response.text().catch(() => '');

      if (isRetryable(response.status) && attempt < this.maxRetries) {
        const waitMs = this.backoffFor(response, attempt);
        this.options.onThrottle?.(waitMs, `${response.status} ${response.statusText}`);
        await sleep(waitMs);
        continue;
      }

      throw new HttpError(
        `${method} ${path} failed: ${response.status} ${response.statusText}${
          text ? `: ${truncate(text)}` : ''
        }`,
        response.status,
        text,
      );
    }

    throw new HttpError(`${method} ${path} failed after ${this.maxRetries} retries`, 429, '');
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async waitForSlot(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
  }

  /** Prefer what the server tells us; fall back to exponential backoff. */
  private backoffFor(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 1000);
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) return Math.max(date - Date.now(), 1000);
    }
    // Jitter so parallel workers don't retry in lockstep.
    return Math.min(2 ** attempt * 1000, 60_000) + Math.random() * 500;
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
