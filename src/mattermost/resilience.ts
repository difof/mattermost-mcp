// Transport resilience layered around Client4 calls: a per-request timeout
// (injected as an AbortSignal so the underlying fetch is actually aborted) and
// retry-with-backoff on transient failures (429 / 5xx / network) for safe reads.
// Resilience is applied per HTTP request, never by replaying a tool callback:
// a failed response does not establish whether a write reached the server.
import type { Client4 } from "@mattermost/client";
import mattermost from "@mattermost/client";
import { log } from "../log.js";

export interface ResilienceConfig {
  /** Per-request timeout in ms; 0 disables. */
  timeoutMs: number;
  /** Additional attempts for safe reads after the first (3 = up to 4 calls). */
  maxRetries: number;
  /** Exponential-backoff base delay in ms. */
  baseDelayMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 500,
};

/**
 * A status is transient (worth retrying) when it is a rate-limit, a server
 * error, or unknown/zero (network failure or aborted request). A `401` is NOT
 * retryable here — auth recovery is handled separately for that request.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status == null || status === 0) return true; // network / aborted
  return status === 429 || (status >= 500 && status <= 599);
}

/** Classify any thrown value: Mattermost ClientError by status, else transport faults. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof mattermost.ClientError) return isRetryableStatus(err.status_code);
  // Bare transport failures that never became a ClientError.
  if (err instanceof TypeError) return true; // fetch network error
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true; // request timed out (AbortSignal.timeout)
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof mattermost.ClientError) return `status ${err.status_code ?? 0}`;
  if (err instanceof Error) return err.name || err.message;
  return String(err);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * `sleep` and `rand` are injectable so tests run instantly and deterministically.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: ResilienceConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
  rand: () => number = Math.random,
  canRetry: (err: unknown) => boolean = isRetryableError,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= cfg.maxRetries || !canRetry(err)) throw err;
      const backoff = cfg.baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(rand() * cfg.baseDelayMs);
      const delay = backoff + jitter;
      attempt += 1;
      log(
        `transient failure (${describeError(err)}); retry ${attempt}/${cfg.maxRetries} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

type RequestOptions = Parameters<Client4["getOptions"]>[0];

/** Trusted operation metadata, separate from caller-supplied HTTP options. */
export interface RequestPolicy {
  retrySafe: boolean;
}

type RequestRunner = <T>(
  url: string,
  options: RequestOptions,
  operation: () => Promise<T>,
  policy?: RequestPolicy,
) => Promise<T>;

const requestRunners = new WeakMap<Client4, RequestRunner>();

/**
 * Share the session's per-request retry/auth policy with bounded raw transports,
 * which cannot use Client4's JSON/text-consuming transport. `operation` must
 * rebuild Client4.getOptions on every attempt for fresh credentials/timeouts.
 * Catalogued operations supply trusted retry safety: some reads use POST, while
 * Mattermost's access-policy activation mutates state using GET.
 */
export function runClientRequest<T>(
  client: Client4,
  url: string,
  options: RequestOptions,
  operation: () => Promise<T>,
  policy?: RequestPolicy,
): Promise<T> {
  const run = requestRunners.get(client);
  return run ? run(url, options, operation, policy) : operation();
}

function isSafeRead(client: Client4, url: string, options: RequestOptions): boolean {
  const method = (options.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (method !== "POST") return false;

  // These read-only POST routes are verified against Client4.searchUsers and
  // Client4.searchPostsWithParams. Do not treat arbitrary POSTs as retryable.
  const base = new URL(client.getBaseRoute());
  const request = new URL(url, base);
  if (request.origin !== base.origin) return false;
  const prefix = `${base.pathname}/`;
  if (!request.pathname.startsWith(prefix)) return false;
  const route = request.pathname.slice(base.pathname.length);
  return (
    route === "/users/search" ||
    route === "/posts/search" ||
    /^\/teams\/[^/]+\/posts\/search$/.test(route)
  );
}

/**
 * Wrap Client4's individual HTTP requests, including login and uploads. The SDK
 * keeps this transport private in its declarations, but it is a normal method
 * at runtime (verified in @mattermost/client 11.6.0). Keep that adaptation here.
 *
 * Writes are sent once on transient failure. An explicit 401 rejection may be
 * retried once after authentication recovers, without replaying earlier calls.
 * The recovery callback returns false for PATs or unrefreshable OAuth tokens.
 */
export function applyRequestResilience(
  client: Client4,
  cfg: ResilienceConfig,
  recoverAuthentication?: () => Promise<boolean>,
): void {
  if (!requestRunners.has(client)) {
    const transport = client as unknown as {
      doFetchWithResponse: <T>(url: string, options: RequestOptions) => Promise<T>;
    };
    const original = transport.doFetchWithResponse.bind(client);
    transport.doFetchWithResponse = <T>(url: string, options: RequestOptions) =>
      runClientRequest(client, url, options, () => original<T>(url, options));
  }

  requestRunners.set(
    client,
    async <T>(
      url: string,
      options: RequestOptions,
      operation: () => Promise<T>,
      policy?: RequestPolicy,
    ) => {
      let recovered = false;
      let recoveryFailed = false;
      const attempt = async (): Promise<T> => {
        const attemptedToken = client.getToken();
        try {
          return await operation();
        } catch (err) {
          const is401 = err instanceof mattermost.ClientError && err.status_code === 401;
          // Failed credentials must not recursively trigger another login attempt.
          const isLogin = url.split("?")[0] === `${client.getUsersRoute()}/login`;
          if (!is401 || recovered || isLogin || !recoverAuthentication || options.signal?.aborted) {
            throw err;
          }
          recovered = true;
          // Another in-flight request may already have refreshed this token.
          if (client.getToken() === attemptedToken) {
            let authenticated: boolean;
            try {
              authenticated = await recoverAuthentication();
            } catch (authError) {
              // A failed login/refresh is not a transient failure of the read.
              recoveryFailed = true;
              throw authError;
            }
            if (!authenticated) throw err;
          }
          return operation();
        }
      };

      if (!(policy?.retrySafe ?? isSafeRead(client, url, options))) return attempt();
      return withRetry(
        attempt,
        cfg,
        undefined,
        undefined,
        (err) => !recoveryFailed && !options.signal?.aborted && isRetryableError(err),
      );
    },
  );
}

/**
 * Make every Client4 request carry an AbortSignal timeout, unless the caller
 * already set one. We wrap `getOptions` (whose result Client4 passes straight to
 * fetch) rather than touching global fetch — the HTTP stays Client4's.
 */
export function applyRequestTimeout(client: Client4, timeoutMs: number): void {
  if (timeoutMs <= 0) return;
  const original = client.getOptions.bind(client);
  client.getOptions = ((options: Parameters<Client4["getOptions"]>[0]) => {
    const opts = original(options);
    if (!opts.signal) {
      (opts as { signal?: AbortSignal }).signal = AbortSignal.timeout(timeoutMs);
    }
    return opts;
  }) as Client4["getOptions"];
}
