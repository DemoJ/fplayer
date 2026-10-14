import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { api, ApiError, getToken, setOnUnauthorized, setToken } from "./api";
import { loadStartup } from "./startup";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let signOuts = 0;
const user = { id: 1, username: "viewer", role: "admin" };
const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  signOuts = 0;
  setOnUnauthorized(() => { signOuts += 1; });
  setToken("current-session");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOnUnauthorized(null);
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("startup restores the user without depending on the setup endpoint", async () => {
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/me");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer current-session");
    return json({ user });
  };
  assert.deepEqual(await loadStartup(), { initialized: true, setupExpired: false, user });
  assert.equal(getToken(), "current-session");
});

test("network failure preserves the credential and retry restores the session", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(loadStartup, /网络连接失败/);
  assert.equal(getToken(), "current-session");
  assert.equal(signOuts, 0);
  globalThis.fetch = async () => json({ user });
  assert.deepEqual((await loadStartup()).user, user);
});

for (const status of [403, 429, 500, 502, 503]) {
  test(`startup HTTP ${status} preserves the credential`, async () => {
    globalThis.fetch = async () => new Response("Service unavailable", { status });
    await assert.rejects(loadStartup, (error: unknown) => error instanceof ApiError && error.status === status);
    assert.equal(getToken(), "current-session");
    assert.equal(signOuts, 0);
  });
}

for (const payload of ["<html>proxy page</html>", "", "null", "{}", '{"user":{}}']) {
  test(`invalid startup payload ${JSON.stringify(payload)} is not a logout`, async () => {
    globalThis.fetch = async () => new Response(payload);
    await assert.rejects(loadStartup, /服务响应异常/);
    assert.equal(getToken(), "current-session");
    assert.equal(signOuts, 0);
  });
}

test("an explicit session 401 clears the current credential once", async () => {
  globalThis.fetch = async () => json({ error: "登录已过期", code: "SESSION_INVALID" }, 401);
  await assert.rejects(() => api("/scans"), /登录已过期/);
  assert.equal(getToken(), null);
  assert.equal(signOuts, 1);
});

test("a /me 401 returns to login without treating it as failed setup", async () => {
  globalThis.fetch = async () => json({ error: "登录已过期" }, 401);
  assert.deepEqual(await loadStartup(), { initialized: true, setupExpired: false });
  assert.equal(getToken(), null);
  assert.equal(signOuts, 1);
});

test("invalid credentials keep the login error rather than an expiry message", async () => {
  globalThis.fetch = async () => json({ error: "用户名或密码错误", code: "INVALID_CREDENTIALS" }, 401);
  await assert.rejects(() => api("/login", { method: "POST" }), /用户名或密码错误/);
  assert.equal(getToken(), "current-session");
  assert.equal(signOuts, 0);
});

test("an unrelated API 401 does not revoke the login", async () => {
  globalThis.fetch = async () => json({ error: "上游服务未授权" }, 401);
  await assert.rejects(() => api("/metadata/check-login", { method: "POST" }), /上游服务未授权/);
  assert.equal(getToken(), "current-session");
  assert.equal(signOuts, 0);
});

test("a late 401 from the previous session cannot clear the new login", async () => {
  let respond!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { respond = resolve; });
  const pending = api("/scans");
  setToken("new-session");
  respond(json({ code: "SESSION_INVALID" }, 401));
  await assert.rejects(pending, /登录已过期/);
  assert.equal(getToken(), "new-session");
  assert.equal(signOuts, 0);
});

test("concurrent expired responses notify logout only once", async () => {
  const responses: Array<(response: Response) => void> = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => { responses.push(resolve); });
  const results = Promise.allSettled([api("/scans"), api("/media")]);
  for (const respond of responses) respond(json({ code: "SESSION_INVALID" }, 401));
  assert.ok((await results).every((result) => result.status === "rejected"));
  assert.equal(getToken(), null);
  assert.equal(signOuts, 1);
});

test("aborted startup responses cannot clear a credential", async () => {
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    return json({ code: "SESSION_INVALID" }, 401);
  };
  await assert.rejects(() => loadStartup(controller.signal), { name: "AbortError" });
  assert.equal(getToken(), "current-session");
  assert.equal(signOuts, 0);
});

test("setup connectivity failures are unknown, not an uninitialized server", async () => {
  localStorage.removeItem("fplayer-token");
  globalThis.fetch = async () => json({ error: "维护中" }, 503);
  await assert.rejects(loadStartup, /维护中/);
  globalThis.fetch = async () => json({});
  await assert.rejects(loadStartup, /服务响应异常/);
  globalThis.fetch = async () => json({ initialized: false, setupExpired: true });
  assert.deepEqual(await loadStartup(), { initialized: false, setupExpired: true });
});

test("Headers instances and no-content responses remain supported", async () => {
  globalThis.fetch = async (_input, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("X-Test"), "value");
    assert.equal(headers.get("Content-Type"), "application/json");
    return new Response(null, { status: 204 });
  };
  assert.equal(await api("/test", { method: "POST", headers: new Headers({ "X-Test": "value" }), body: "{}" }), undefined);
});
