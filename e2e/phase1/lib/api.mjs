/**
 * Minimal client for the control plane's public API, behaving like the
 * dashboard: it keeps the session cookie and sends the control plane's own
 * Origin on every request.
 *
 * @module
 */

/** An API error with the response attached. */
export class ApiError extends Error {
  /**
   * @param {string} message - Summary.
   * @param {number} status - HTTP status.
   * @param {unknown} body - Parsed body.
   */
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Cookie-carrying API client. */
export class Api {
  /**
   * @param {string} base - Control plane origin, e.g. `http://127.0.0.1:8797`.
   */
  constructor(base) {
    this.base = base;
    /** @type {Map<string, string>} */
    this.cookies = new Map();
  }

  /** The `Cookie` header value for the current session. */
  get cookie() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /**
   * Sends a request.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Path and query.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<{ status: number, body: any }>}
   */
  async request(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        origin: this.base,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookies.size ? { cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  /**
   * Sends a request and returns the body, throwing unless the status is 2xx.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Path and query.
   * @param {unknown} [body] - JSON body.
   * @returns {Promise<any>}
   * @throws {ApiError}
   */
  async ok(method, path, body) {
    const res = await this.request(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(
        `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`,
        res.status,
        res.body,
      );
    }
    return res.body;
  }

  /** @param {string} path */
  get(path) {
    return this.ok("GET", path);
  }

  /** @param {string} path @param {unknown} [body] */
  post(path, body) {
    return this.ok("POST", path, body ?? {});
  }

  /** @param {string} path @param {unknown} body */
  put(path, body) {
    return this.ok("PUT", path, body);
  }

  /** @param {string} path @param {unknown} body */
  patch(path, body) {
    return this.ok("PATCH", path, body);
  }

  /** @param {string} path */
  delete(path) {
    return this.ok("DELETE", path);
  }
}
