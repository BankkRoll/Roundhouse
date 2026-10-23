/**
 * Base for the in-memory provider APIs used in tests, each exposed as a
 * `fetch` function.
 *
 * The base records requests, runs fault injectors, enforces bearer auth
 * (`rw-token` writes, `ro-token` only reads), and models an abort that lands
 * while a request is in flight: the change is applied but the response is
 * lost. Subclasses route requests with the provider's documented shapes and
 * implement the hooks the conformance suite drives.
 *
 * @module
 */
import type { FetchLike } from "../../src/http";

/** A request the fake received. */
export interface RecordedRequest {
  method: string;
  /** Path below the API version prefix, e.g. `/servers`. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  token: string | null;
  /** The original URL and init, to replay with {@link FakeApi.passthrough}. */
  url: string;
  init: RequestInit;
}

/** Returns a response to short-circuit a request, or `undefined` to continue. */
export type Interceptor = (
  req: RecordedRequest,
) => Response | undefined | Promise<Response | undefined>;

/** Token scope in the fakes. */
export type Scope = "rw" | "ro";

/**
 * A JSON response.
 *
 * @param status - HTTP status.
 * @param body - Body, or `undefined` for none.
 * @param headers - Extra headers.
 * @returns The response.
 */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** What the conformance suite seeds. */
export interface SeedServer {
  name: string;
  labels: Record<string, string>;
  status?: "running" | "deleting";
}

/** In-memory provider API. */
export abstract class FakeApi {
  /** Known tokens and their scope. */
  readonly tokens = new Map<string, Scope>([
    ["rw-token", "rw"],
    ["ro-token", "ro"],
  ]);
  /** Every request received, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Polls of a new server before it runs. */
  bootPolls = 2;
  /** New servers never come up. */
  neverBoot = false;
  /** `fetch` bound to this fake. */
  readonly fetch: FetchLike = (input, init) => this.handle(input, init);

  /** API version prefix stripped from paths, e.g. `/v1`. */
  protected abstract readonly prefix: string;
  private interceptors: Interceptor[] = [];
  private nextId = 1000;

  /**
   * Adds a fault injector; it runs before routing, in insertion order.
   *
   * @param fn - Interceptor.
   */
  intercept(fn: Interceptor): void {
    this.interceptors.push(fn);
  }

  /** Requests other than GET. */
  get mutations(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  /**
   * Routes a recorded request without interceptors, e.g. to apply a create
   * whose response an interceptor then loses.
   *
   * @param req - Recorded request.
   * @returns The response the API would have sent.
   */
  passthrough(req: RecordedRequest): Promise<Response> {
    return Promise.resolve(this.route(req));
  }

  /** @returns A fresh numeric ID. */
  protected id(): number {
    return this.nextId++;
  }

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      path: url.pathname.startsWith(this.prefix)
        ? url.pathname.slice(this.prefix.length)
        : url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      token: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
      url: input,
      init,
    };
    this.requests.push(req);
    if (init.signal?.aborted) throw init.signal.reason;
    for (const fn of this.interceptors) {
      const res = await fn(req);
      if (res) return res;
    }
    const scope = req.token ? this.tokens.get(req.token) : undefined;
    if (!scope) return this.unauthorized();
    if (req.method !== "GET" && scope === "ro") return this.forbidden();
    const res = await this.route(req);
    // An abort that lands while the request is in flight loses the response,
    // even though the change was applied.
    if (init.signal?.aborted) throw init.signal.reason;
    this.decorate(res, req);
    return res;
  }

  /** The provider's `401` response. */
  protected abstract unauthorized(): Response;
  /** The provider's response to a write with a read-only token. */
  protected abstract forbidden(): Response;
  /** Routes an authorised request. */
  protected abstract route(req: RecordedRequest): Response | Promise<Response>;
  /** Adds headers to every routed response, e.g. rate limits. */
  protected decorate(_res: Response, _req: RecordedRequest): void {}

  // ---------------------------------------------------------------------------
  // Conformance hooks
  // ---------------------------------------------------------------------------

  /** Adds a running server directly. @returns Its ID. */
  abstract seedServer(spec: SeedServer): string;
  /** IDs of every server. */
  abstract serverIds(): string[];
  /** Number of firewalls. */
  abstract firewallCount(): number;
  /** Number of SSH key objects. */
  abstract sshKeyCount(): number;
  /** Whether a request creates a server. */
  abstract isCreate(req: RecordedRequest): boolean;
  /** Whether a request deletes a server. */
  abstract isDelete(req: RecordedRequest): boolean;
  /** The provider's error response for a status, in its own format. */
  abstract errorResponse(status: number, message?: string): Response;
  /** Root passwords the fake hands out, which must never surface. */
  abstract readonly secrets: string[];
}
