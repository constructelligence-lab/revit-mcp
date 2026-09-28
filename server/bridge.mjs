// The bridge: the MCP server's side of the conversation with the add-in running inside Revit.
//
// Everything here is loopback HTTP against one process on this machine (default 127.0.0.1:8712), because
// the Revit API is in-process: only code loaded into Revit may touch a document, and only on Revit's own
// thread. The add-in owns that thread; this file owns the timeout and the error messages.
//
// The two failure modes worth naming, because they look alike from an AI client and are not:
//   · Revit is not running, or the add-in is not loaded → connection refused.
//   · Revit is running but a modal dialog is open → the UI thread is blocked, so the request hangs until
//     its timeout. The message says so rather than "unknown error".
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8712';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The add-in writes its bearer token here on first run; the server reads it unless REVIT_MCP_TOKEN is set. */
export const TOKEN_FILE = join(homedir(), '.revit-mcp', 'token');
export const BRIDGE_VERSION = '0.1.0';

export class BridgeError extends Error {
  constructor(message, { code = 'bridge_error', status } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

/** A token from the environment beats the file the add-in wrote. Empty means "the add-in is not asking for one". */
export function discoverToken(env = process.env) {
  if (env.REVIT_MCP_TOKEN?.trim()) return env.REVIT_MCP_TOKEN.trim();
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    // An unreadable token file is not worth failing over: the request will come back 401 and say so.
  }
  return '';
}

export class Bridge {
  #url;
  #token;
  #timeoutMs;
  #fetch;

  constructor({ url = DEFAULT_BRIDGE_URL, token = discoverToken(), timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.#url = url.replace(/\/+$/, '');
    this.#token = token || '';
    this.#timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.#fetch = fetchImpl;
  }

  get url() {
    return this.#url;
  }

  /** Whether a bearer token will be sent (not whether it is the right one — only the add-in knows that). */
  get hasToken() {
    return this.#token.length > 0;
  }

  /** The add-in's own view of itself: version, the open document, and whether it will accept writes. */
  async health() {
    return this.#request('GET', '/health');
  }

  /** Run one bridge operation (docs/protocol.md) and return its result. */
  async call(op, args = {}) {
    const body = await this.#request('POST', '/op', { op, args });
    return body.result;
  }

  async #request(method, path, payload) {
    const headers = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;

    let response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new BridgeError(
        timedOut
          ? `Revit did not answer within ${Math.round(this.#timeoutMs / 1000)}s. A modal dialog or a long-running command blocks Revit's UI thread — close it and try again, or ask for less at once.`
          : `No revit-mcp add-in at ${this.#url}. Open Autodesk Revit with the add-in loaded, or start this server with --mock to work against the sample model.`,
        { code: timedOut ? 'timeout' : 'unreachable' },
      );
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      throw new BridgeError(`The add-in answered ${response.status} with something that is not JSON.`, { code: 'bad_response', status: response.status });
    }

    if (response.status === 401) {
      throw new BridgeError(
        `The add-in refused the token. Copy the token from ${TOKEN_FILE} or set REVIT_MCP_TOKEN to match the add-in's setting.`,
        { code: 'unauthorized', status: 401 },
      );
    }
    if (!response.ok || body?.ok === false) {
      const message = body?.error?.message || `The add-in answered ${response.status}.`;
      throw new BridgeError(message, { code: body?.error?.code || 'bridge_error', status: response.status });
    }
    return body;
  }
}
