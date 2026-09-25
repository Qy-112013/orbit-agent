import { setTimeout as delay } from 'node:timers/promises';

export interface RetryOptions {
  maxRetries?: number;
  timeoutMs: number;
  /** 'total' bounds each attempt including the body; 'headers' stops at the response headers so callers can stream. */
  timeoutScope?: 'total' | 'headers';
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Caller cancellation; never retried. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

const RETRYABLE_STATUS = new Set([408, 409, 429]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

/** Seconds or an HTTP date; null when absent or unparseable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Retries transient failures (408/409/429/5xx, network errors, per-attempt
 * timeouts) with exponential backoff and jitter, honouring retry-after.
 * Returns the last response once retries are exhausted or the status is not
 * retryable, so callers keep their own HTTP error reporting.
 */
export async function fetchWithRetry(url: string, init: RequestInit, {
  maxRetries = 2, timeoutMs, timeoutScope = 'total', baseDelayMs = 500, maxDelayMs = 8_000, signal,
  sleep = delay, fetchImpl = fetch, random = Math.random,
}: RetryOptions): Promise<{ response: Response; attempts: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const headersController = new AbortController();
    const timeout = timeoutScope === 'total' ? AbortSignal.timeout(timeoutMs) : headersController.signal;
    const timer = timeoutScope === 'headers'
      ? setTimeout(() => headersController.abort(new DOMException('request timed out', 'TimeoutError')), timeoutMs) : undefined;
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    const retryable = response ? isRetryableStatus(response.status) : true;
    if (!retryable || attempt > maxRetries) {
      if (response) return { response, attempts: attempt };
      throw failure;
    }
    const hinted = response ? retryAfterMs(response.headers.get('retry-after')) : null;
    await response?.body?.cancel().catch(() => undefined);
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + random() / 2);
    await sleep(hinted === null ? backoff : Math.min(maxDelayMs, hinted));
  }
}
