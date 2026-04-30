import CDP from "chrome-remote-interface";
import type { ChromeClient } from "./chrome.js";
import type {
  HttpRequestInput,
  HttpResponse,
  RosettaSession,
  SessionMeta,
} from "./types.js";

export type Logger = (message: string) => void;

/**
 * Opens a session against a Chrome instance that is already (or about to be)
 * signed into chatgpt.com, and exposes a `httpRequest` shim that runs
 * `fetch(...)` *inside* Chrome.
 *
 * Doing the requests from Chrome rather than Node bypasses Cloudflare bot
 * detection (TLS fingerprint, sec-ch-ua headers, ja3 hash). Chrome's network
 * stack is already authorized; we just orchestrate.
 *
 * Caller decides Chrome lifecycle. Pass the CDP debug port for an existing
 * Chrome (started with `--remote-debugging-port=<port>`).
 */
export interface OpenSessionInput {
  /** CDP debugging port. */
  port: number;
  /** CDP debugging host. Defaults to 127.0.0.1. */
  host?: string;
  /** If provided, attach to this CDP target id; otherwise the active page. */
  targetId?: string;
  log?: Logger;
  /** Origin to navigate to; default https://chatgpt.com. */
  baseUrl?: string;
  /** Total time we wait for cookie + token retrieval. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://chatgpt.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export class RosettaAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-logged-in"
      | "no-page-target"
      | "cdp-eval-failed"
      | "fetch-failed"
      | "no-access-token"
      | "missing-cookies",
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "RosettaAuthError";
  }
}

export async function openSession(input: OpenSessionInput): Promise<RosettaSession> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = input.log;

  const client = await connect(input);
  let closed = false;

  try {
    const targetId = await ensureChatgptOrigin(client, baseUrl, log);

    const sessionJson = await withTimeout(
      timeoutMs,
      evalSessionEndpoint(client, baseUrl),
      "fetch /api/auth/session",
    );
    if (typeof sessionJson !== "object" || sessionJson === null) {
      throw new RosettaAuthError(
        "/api/auth/session returned a non-object response",
        "fetch-failed",
        "Confirm the Chrome page is on chatgpt.com (not /auth/login).",
      );
    }
    const accessToken = (sessionJson as Record<string, unknown>).accessToken;
    const expiresIso = (sessionJson as Record<string, unknown>).expires;
    if (typeof accessToken !== "string" || accessToken.length < 20) {
      throw new RosettaAuthError(
        "No accessToken in /api/auth/session response — the Chrome profile is not logged in.",
        "not-logged-in",
        "Open chatgpt.com in this Chrome and sign in, then re-run.",
      );
    }
    const expiresAt = parseExpiry(expiresIso);
    const deviceId = await readDeviceId(client);
    const userAgent = await readUserAgent(client);

    const meta: SessionMeta = {
      accessToken,
      expiresAt,
      userAgent,
      deviceId,
      acquiredAt: Date.now(),
      targetId,
      cdpPort: input.port,
      cdpHost: input.host ?? "127.0.0.1",
    };
    log?.(
      `rosetta: session opened (token expires in ${Math.round((expiresAt - Date.now()) / 60000)}min, deviceId=${deviceId.slice(0, 8)}...)`,
    );

    const session: RosettaSession = {
      client,
      meta,
      httpRequest: (req) => httpRequestViaChrome(client, req, baseUrl),
      async close() {
        if (closed) return;
        closed = true;
        await client.close().catch(() => undefined);
      },
    };
    return session;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connect(input: OpenSessionInput): Promise<ChromeClient> {
  const opts: CDP.Options = {
    port: input.port,
    host: input.host ?? "127.0.0.1",
  };
  if (input.targetId) {
    opts.target = input.targetId;
  }
  return (await CDP(opts)) as unknown as ChromeClient;
}

async function ensureChatgptOrigin(
  client: ChromeClient,
  baseUrl: string,
  log?: Logger,
): Promise<string | undefined> {
  const { Page, Runtime, Network, Target } = client;
  await Network.enable({});
  await Page.enable();
  await Runtime.enable();

  const currentUrl = (
    await Runtime.evaluate({ expression: "location.href", returnByValue: true })
  ).result?.value as string | undefined;
  if (currentUrl && currentUrl.startsWith(baseUrl)) {
    return undefined;
  }
  log?.(`rosetta: navigating Chrome tab to ${baseUrl}`);
  await Page.navigate({ url: `${baseUrl}/` });
  await waitForLoad(client, 15_000);
  try {
    const info = await Target.getTargetInfo({});
    return (info as { targetInfo?: { targetId?: string } }).targetInfo?.targetId;
  } catch {
    return undefined;
  }
}

async function waitForLoad(client: ChromeClient, timeoutMs: number): Promise<void> {
  const { Page } = client;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    Page.loadEventFired().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function evalSessionEndpoint(client: ChromeClient, baseUrl: string): Promise<unknown> {
  const { Runtime } = client;
  const expression = `(async () => {
    const res = await fetch(${JSON.stringify(`${baseUrl}/api/auth/session`)}, {
      credentials: "include",
      cache: "no-store",
      headers: { "accept": "application/json" },
    });
    if (!res.ok) {
      return { __error: true, status: res.status, body: await res.text().catch(() => "") };
    }
    return await res.json();
  })()`;
  const result = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new RosettaAuthError(
      `CDP eval threw: ${result.exceptionDetails.text}`,
      "cdp-eval-failed",
    );
  }
  const value = result.result?.value;
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__error === true
  ) {
    const status = (value as Record<string, unknown>).status;
    throw new RosettaAuthError(
      `/api/auth/session returned HTTP ${status}`,
      "fetch-failed",
      "If 401, the profile is not signed in. If 403, Cloudflare may be challenging — let the page settle and retry.",
    );
  }
  return value;
}

async function readDeviceId(client: ChromeClient): Promise<string> {
  const { Network } = client;
  const { cookies } = await Network.getCookies({
    urls: ["https://chatgpt.com", "https://auth.openai.com"],
  });
  const did = cookies.find((c) => c.name === "oai-did");
  return did?.value ?? "";
}

async function readUserAgent(client: ChromeClient): Promise<string> {
  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: "navigator.userAgent",
    returnByValue: true,
  });
  const value = result.result?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new RosettaAuthError(
      "Could not read navigator.userAgent from Chrome.",
      "cdp-eval-failed",
    );
  }
  return value;
}

/**
 * Executes a fetch call inside Chrome. Cookies, TLS context, and ChatGPT-specific
 * sec-* headers are supplied by Chrome itself.
 */
async function httpRequestViaChrome(
  client: ChromeClient,
  input: HttpRequestInput,
  baseUrl: string,
): Promise<HttpResponse> {
  const { Runtime } = client;
  const url = input.url.startsWith("http") ? input.url : `${baseUrl}${input.url}`;
  const responseType = input.responseType ?? "json";
  const fetchInit = {
    method: input.method,
    credentials: "include" as const,
    cache: "no-store" as const,
    headers: input.headers ?? {},
    body: input.body,
  };
  const expression = `(async () => {
    const init = ${JSON.stringify(fetchInit)};
    let response;
    try {
      response = await fetch(${JSON.stringify(url)}, init);
    } catch (err) {
      return { __error: true, kind: "network", message: String(err) };
    }
    const headers = {};
    response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const contentType = (headers["content-type"] || "").toLowerCase();
    const wantText = ${JSON.stringify(responseType !== "json")};
    let body;
    if (wantText) {
      body = await response.text();
    } else if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    return { __error: false, status: response.status, body, contentType, headers };
  })()`;

  const result = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `rosetta: CDP fetch eval threw: ${result.exceptionDetails.text ?? "unknown"}`,
    );
  }
  const value = result.result?.value as
    | { __error: false; status: number; body: unknown; contentType: string; headers: Record<string, string> }
    | { __error: true; kind: string; message: string };
  if (!value) {
    throw new Error("rosetta: CDP fetch returned undefined");
  }
  if (value.__error) {
    throw new Error(
      `rosetta: in-Chrome fetch failed (${value.kind}): ${value.message}`,
    );
  }
  return {
    status: value.status,
    body: value.body,
    contentType: value.contentType,
    headers: value.headers,
  };
}

function parseExpiry(value: unknown): number {
  if (typeof value !== "string") return Date.now() + 50 * 60_000;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return ms;
  return Date.now() + 50 * 60_000;
}

async function withTimeout<T>(ms: number, promise: Promise<T>, label: string): Promise<T> {
  if (ms <= 0) {
    throw new RosettaAuthError(`Timeout exhausted before ${label}`, "fetch-failed");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RosettaAuthError(`Timed out (${ms}ms) waiting for ${label}`, "fetch-failed"));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
