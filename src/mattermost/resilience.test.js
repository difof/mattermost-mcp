import { describe, it, expect, vi } from "vitest";
import mattermost from "@mattermost/client";
import {
  isRetryableStatus,
  isRetryableError,
  withRetry,
  applyRequestResilience,
  applyRequestTimeout,
  runClientRequest,
} from "./resilience.js";
const cfg = (over = {}) => ({
  timeoutMs: 0,
  maxRetries: 3,
  baseDelayMs: 100,
  ...over,
});
const mmError = (status) =>
  new mattermost.ClientError("http://mm.test", { message: "boom", status_code: status });
describe("isRetryableStatus", () => {
  it("retries rate-limit, server errors, and network/zero/unknown", () => {
    for (const s of [429, 500, 503, 599, 0, undefined]) expect(isRetryableStatus(s)).toBe(true);
  });
  it("does not retry client errors", () => {
    for (const s of [400, 401, 403, 404, 200]) expect(isRetryableStatus(s)).toBe(false);
  });
});
describe("isRetryableError", () => {
  it("retries a transient ClientError but not a 401/404", () => {
    expect(isRetryableError(mmError(503))).toBe(true);
    expect(isRetryableError(mmError(401))).toBe(false);
    expect(isRetryableError(mmError(404))).toBe(false);
  });
  it("retries bare transport faults (TypeError, timeout abort)", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isRetryableError(timeout)).toBe(true);
  });
  it("does not retry an ordinary error", () => {
    expect(isRetryableError(new Error("nope"))).toBe(false);
  });
});
describe("withRetry", () => {
  const noSleep = vi.fn(async () => {});
  const noJitter = () => 0;
  it("returns immediately on success (no sleep)", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withRetry(fn, cfg(), noSleep, noJitter)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });
  it("retries transient failures then succeeds, with exponential backoff", async () => {
    const sleeps = [];
    const sleep = vi.fn(async (ms) => void sleeps.push(ms));
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw mmError(503);
      return "recovered";
    });
    await expect(withRetry(fn, cfg({ baseDelayMs: 100 }), sleep, noJitter)).resolves.toBe(
      "recovered",
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // 100*2^0, 100*2^1 (jitter 0)
  });
  it("gives up after maxRetries and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw mmError(500);
    });
    await expect(
      withRetry(
        fn,
        cfg({ maxRetries: 2 }),
        vi.fn(async () => {}),
        noJitter,
      ),
    ).rejects.toMatchObject({
      status_code: 500,
    });
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
  it("does not retry a non-transient error", async () => {
    const fn = vi.fn(async () => {
      throw mmError(404);
    });
    await expect(withRetry(fn, cfg(), noSleep, noJitter)).rejects.toMatchObject({
      status_code: 404,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
describe("trusted operation retry policy", () => {
  it.each([
    { method: "GET", retrySafe: false, calls: 1 },
    { method: "POST", retrySafe: true, calls: 2 },
  ])("uses retrySafe=$retrySafe for a $method request", async ({ method, retrySafe, calls }) => {
    const client = new mattermost.Client4();
    client.setUrl("http://mm.test");
    applyRequestResilience(client, cfg({ maxRetries: 1, baseDelayMs: 0 }));
    const operation = vi.fn().mockRejectedValueOnce(mmError(503)).mockResolvedValue("ok");
    // The caller supplies trusted operation metadata independently of the verb:
    // v11 policy activation is a GET mutation, and bulk lookup uses POST.
    const result = runClientRequest(
      client,
      "http://mm.test/api/v4/example",
      { method },
      operation,
      { retrySafe },
    );
    if (retrySafe) await expect(result).resolves.toBe("ok");
    else await expect(result).rejects.toMatchObject({ status_code: 503 });
    expect(operation).toHaveBeenCalledTimes(calls);
  });
});
describe("applyRequestTimeout", () => {
  function fakeClient() {
    return { getOptions: () => ({ headers: {} }) };
  }
  it("injects an AbortSignal when a timeout is set", () => {
    const client = fakeClient();
    applyRequestTimeout(client, 5000);
    const opts = client.getOptions({});
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
  it("is a no-op when the timeout is 0", () => {
    const client = fakeClient();
    applyRequestTimeout(client, 0);
    expect(client.getOptions({}).signal).toBeUndefined();
  });
  it("does not overwrite an existing signal", () => {
    const existing = AbortSignal.timeout(1000);
    const client = { getOptions: () => ({ headers: {}, signal: existing }) };
    applyRequestTimeout(client, 5000);
    expect(client.getOptions().signal).toBe(existing);
  });
});
