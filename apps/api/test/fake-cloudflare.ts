/**
 * An in-process fake of the Cloudflare APIs the Containers provider calls
 * (ADR 0011 "Testing strategy"), installed with `setCloudflareApiTransport`:
 * - Workers scripts (multipart upload with metadata validation, the
 *   `workers.dev` subdomain switch, delete, list) and the account subdomain;
 * - Durable Object namespaces, created by a script's first upload;
 * - Containers applications, rollouts (a scripted progression: a rollout
 *   stays active for `rolloutPolls` application reads, then completes or
 *   fails as `rolloutOutcome` says) and `instances-v2`;
 * - registry credentials, and the registry's tag list and manifest delete;
 * - zones and Worker routes;
 * - the runtime's `workers.dev` warm-up, answered 200 only for a valid
 *   `RH-Warm` of the uploaded token and generation.
 *
 * Every request needs `Authorization: Bearer <token>` (Basic for the
 * registry) and is appended to {@link FakeCloudflare.log}, so tests assert
 * the order of calls. {@link FakeCloudflare.failNext} scripts one error
 * answer in Cloudflare's envelope.
 *
 * NOTE: the bodies of the Containers endpoints (application create, rollout
 * create, the rollout and `active_rollout_id` fields, `instances-v2`), the
 * registry credential response and the registry's delete support are
 * guesses from the public reference and wrangler, pending live verification
 * (ADR 0011 "Open questions"). The script upload, routes, zones and DO
 * namespace shapes follow the documented API.
 */
import { warmHeaderValue } from "../src/cf-runtime";

/** One logged request. */
export interface FakeRequest {
  method: string;
  /** Path (with query) for the API; `host + path` for registry and workers.dev. */
  path: string;
  /** Parsed JSON body, or the upload's metadata for a script upload. */
  body?: unknown;
}

interface Script {
  metadata: Record<string, unknown>;
  bindings: Record<string, { type: string; text?: string; [k: string]: unknown }>;
  workersDev: boolean;
  uploads: number;
}

interface Application {
  id: string;
  name: string;
  max_instances: number;
  instances: number;
  configuration: { image: string; instance_type?: string };
  durable_objects: { namespace_id: string };
  constraints?: unknown;
  active_rollout_id: string | null;
}

interface Rollout {
  id: string;
  status: string;
  status_message?: string;
  pollsLeft: number;
  image: string;
}

/** Fake Cloudflare account; see the module doc. */
export class FakeCloudflare {
  readonly accountId = "0123456789abcdef0123456789abcdef";
  readonly token = "cf-test-token-not-real-0000000000AbCd";
  readonly subdomain = "acme-test";
  readonly zone = { id: "fedcba9876543210fedcba9876543210", name: "example.com" };
  /** Every request, in order. */
  log: FakeRequest[] = [];
  scripts = new Map<string, Script>();
  namespaces: { id: string; name: string; script: string; class: string }[] = [];
  applications = new Map<string, Application>();
  rollouts = new Map<string, Rollout>();
  routes: { id: string; pattern: string; script: string }[] = [];
  /** Tags per repository (`<account>/<script>`). */
  tags = new Map<string, string[]>();
  /** Application reads a rollout stays active for. */
  rolloutPolls = 2;
  /** How the next rollouts end. */
  rolloutOutcome: { status: string; message?: string } = { status: "completed" };
  /** Called with each API request before it is answered, e.g. to snapshot state. */
  onRequest: ((r: FakeRequest) => Promise<void>) | null = null;
  /** Warm-up answer for a valid header; invalid ones always get 404. */
  warmStatus = 200;
  private failures: { method: string; path: RegExp; status: number; errors: unknown[] }[] = [];
  private seq = 0;

  /**
   * Makes the next matching request fail with Cloudflare's envelope.
   *
   * @param method - HTTP method.
   * @param path - Matched against the logged path.
   * @param status - HTTP status.
   * @param message - The error message.
   * @param code - The error code.
   */
  failNext(method: string, path: RegExp, status: number, message: string, code = 10000): void {
    this.failures.push({ method, path, status, errors: [{ code, message }] });
  }

  /** Paths of logged requests, `METHOD path` with IDs as they were. */
  calls(): string[] {
    return this.log.map((r) => `${r.method} ${r.path}`);
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}${this.seq.toString(16).padStart(8, "0")}`;
  }

  private ok(result: unknown, status = 200): Response {
    return Response.json({ success: true, errors: [], messages: [], result }, { status });
  }

  private error(status: number, message: string, code = 10000): Response {
    return Response.json(
      { success: false, errors: [{ code, message }], messages: [], result: null },
      { status },
    );
  }

  /** The transport: pass to `setCloudflareApiTransport`. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith(".workers.dev")) return this.warm(req, url);
    if (url.hostname === "registry.cloudflare.com") return this.registry(req, url);
    const path = url.pathname.replace(/^\/client\/v4/, "") + url.search;
    const entry: FakeRequest = { method: req.method, path };
    this.log.push(entry);
    await this.onRequest?.(entry);
    if (req.headers.get("authorization") !== `Bearer ${this.token}`) {
      return this.error(403, "Authentication error", 10000);
    }
    const failure = this.failures.findIndex((f) => f.method === req.method && f.path.test(path));
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1);
      return Response.json(
        { success: false, errors: f!.errors, messages: [], result: null },
        { status: f!.status },
      );
    }
    const a = `/accounts/${this.accountId}`;
    const p = url.pathname.replace(/^\/client\/v4/, "");
    const json = async () => {
      const body = await req.json();
      entry.body = body;
      return body as Record<string, unknown>;
    };
    let m = [] as unknown as RegExpExecArray;
    const at = (re: RegExp, text: string): boolean => {
      const found = re.exec(text);
      if (found) m = found;
      return found !== null;
    };

    if (req.method === "GET" && (p === `${a}/tokens/verify` || p === "/user/tokens/verify")) {
      return this.ok({ id: "tok", status: "active" });
    }
    if (req.method === "GET" && p === `${a}/workers/scripts`) {
      return this.ok([...this.scripts.keys()].map((id) => ({ id })));
    }
    if (req.method === "GET" && p === `${a}/workers/subdomain`) {
      return this.ok({ subdomain: this.subdomain });
    }
    if (req.method === "GET" && p === `${a}/workers/durable_objects/namespaces`) {
      return this.ok(this.namespaces);
    }
    if (at(new RegExp(`^${a}/workers/scripts/([^/]+)$`), p)) {
      const name = decodeURIComponent(m[1]!);
      if (req.method === "PUT") return this.upload(req, name, entry);
      if (req.method === "DELETE") {
        if (!this.scripts.delete(name))
          return this.error(404, "workers.api.error.script_not_found", 10007);
        this.namespaces = this.namespaces.filter((n) => n.script !== name);
        return this.ok(null);
      }
    }
    if (at(new RegExp(`^${a}/workers/scripts/([^/]+)/subdomain$`), p) && req.method === "POST") {
      const script = this.scripts.get(decodeURIComponent(m[1]!));
      if (!script) return this.error(404, "workers.api.error.script_not_found", 10007);
      const body = await json();
      script.workersDev = body.enabled === true;
      return this.ok({ enabled: script.workersDev, previews_enabled: false });
    }
    if (p === `${a}/containers/applications`) {
      if (req.method === "GET") return this.ok([...this.applications.values()]);
      if (req.method === "POST") {
        const body = await json();
        const ns = (body.durable_objects as { namespace_id?: string } | undefined)?.namespace_id;
        if (!this.namespaces.some((n) => n.id === ns)) {
          return this.error(400, "durable_objects.namespace_id does not exist", 1000);
        }
        if ([...this.applications.values()].some((x) => x.name === body.name)) {
          return this.error(409, "an application with this name already exists", 1001);
        }
        const app: Application = {
          id: this.id("app"),
          name: body.name as string,
          max_instances: body.max_instances as number,
          instances: (body.instances as number) ?? 0,
          configuration: body.configuration as Application["configuration"],
          durable_objects: { namespace_id: ns! },
          constraints: body.constraints,
          active_rollout_id: null,
        };
        this.applications.set(app.id, app);
        return this.ok(app, 201);
      }
    }
    if (at(new RegExp(`^${a}/containers/applications/([^/]+)$`), p)) {
      const app = this.applications.get(m[1]!);
      if (!app) return this.error(404, "application not found", 1404);
      if (req.method === "GET") {
        this.progress(app);
        return this.ok(app);
      }
      if (req.method === "PATCH") {
        const body = await json();
        if (typeof body.max_instances === "number") app.max_instances = body.max_instances;
        if (body.constraints) app.constraints = body.constraints;
        return this.ok(app);
      }
      if (req.method === "DELETE") {
        this.applications.delete(app.id);
        return this.ok(null);
      }
    }
    if (
      at(new RegExp(`^${a}/containers/applications/([^/]+)/rollouts$`), p) &&
      req.method === "POST"
    ) {
      const app = this.applications.get(m[1]!);
      if (!app) return this.error(404, "application not found", 1404);
      const body = await json();
      const target = body.target_configuration as { image: string };
      const r: Rollout = {
        id: this.id("rol"),
        status: "progressing",
        pollsLeft: this.rolloutPolls,
        image: target.image,
      };
      this.rollouts.set(r.id, r);
      app.active_rollout_id = r.id;
      return this.ok({ id: r.id, status: r.status }, 201);
    }
    if (at(new RegExp(`^${a}/containers/applications/([^/]+)/rollouts/([^/]+)$`), p)) {
      const r = this.rollouts.get(m[2]!);
      if (!r) return this.error(404, "rollout not found", 1404);
      return this.ok({ id: r.id, status: r.status, status_message: r.status_message });
    }
    if (at(new RegExp(`^${a}/containers/applications/([^/]+)/instances-v2$`), p)) {
      const app = this.applications.get(m[1]!);
      if (!app) return this.error(404, "application not found", 1404);
      return this.ok({
        instances: Array.from({ length: Math.min(app.max_instances, 2) }, (_, i) => ({
          id: `ins${i}`,
          state: i === 0 ? "running" : "stopped",
        })),
      });
    }
    if (
      p === `${a}/containers/registries/registry.cloudflare.com/credentials` &&
      req.method === "POST"
    ) {
      const body = await json();
      if (!Array.isArray(body.permissions) || !body.permissions.length) {
        return this.error(400, "permissions required", 1000);
      }
      return this.ok({
        account_id: this.accountId,
        registry_host: "registry.cloudflare.com",
        username: "v1",
        password: `reg-${body.permissions.join("-")}-secret`,
      });
    }
    if (p === "/zones" && req.method === "GET") {
      const name = url.searchParams.get("name");
      return this.ok(name === this.zone.name ? [this.zone] : []);
    }
    if (p === `/zones/${this.zone.id}/workers/routes`) {
      if (req.method === "GET") return this.ok(this.routes);
      if (req.method === "POST") {
        const body = await json();
        if (this.routes.some((r) => r.pattern === body.pattern)) {
          return this.error(409, "A route with the same pattern already exists", 10020);
        }
        const r = {
          id: this.id("rte"),
          pattern: body.pattern as string,
          script: body.script as string,
        };
        this.routes.push(r);
        return this.ok(r);
      }
    }
    if (at(new RegExp(`^/zones/${this.zone.id}/workers/routes/([^/]+)$`), p)) {
      const i = this.routes.findIndex((r) => r.id === m![1]);
      if (i < 0) return this.error(404, "route not found", 10019);
      if (req.method === "DELETE") {
        this.routes.splice(i, 1);
        return this.ok({ id: m[1] });
      }
      if (req.method === "PUT") {
        const body = await json();
        this.routes[i] = {
          id: m[1]!,
          pattern: body.pattern as string,
          script: body.script as string,
        };
        return this.ok(this.routes[i]);
      }
    }
    return this.error(404, `fake: no route for ${req.method} ${p}`, 7003);
  };

  private progress(app: Application) {
    if (!app.active_rollout_id) return;
    const r = this.rollouts.get(app.active_rollout_id)!;
    if (r.pollsLeft-- > 0) return;
    r.status = this.rolloutOutcome.status;
    if (this.rolloutOutcome.message) r.status_message = this.rolloutOutcome.message;
    if (r.status === "completed") app.configuration = { ...app.configuration, image: r.image };
    app.active_rollout_id = null;
  }

  private async upload(req: Request, name: string, entry: FakeRequest): Promise<Response> {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return this.error(400, "Expected a multipart/form-data body", 10021);
    }
    const metaPart = form.get("metadata");
    if (!metaPart || typeof metaPart === "string")
      return this.error(400, "metadata part missing", 10021);
    const metadata = JSON.parse(await metaPart.text()) as Record<string, unknown>;
    entry.body = metadata;
    const main = metadata.main_module;
    if (typeof main !== "string" || !form.get(main)) {
      return this.error(400, "main_module must name an uploaded module", 10021);
    }
    const bindings = (metadata.bindings ?? []) as { name: string; type: string; text?: string }[];
    for (const required of ["APP", "CONTROL", "RH_RUNTIME_TOKEN", "RH_CONFIG"]) {
      if (!bindings.some((b) => b.name === required)) {
        return this.error(400, `binding ${required} missing`, 10021);
      }
    }
    const existing = this.scripts.get(name);
    const migrations = metadata.migrations as { new_sqlite_classes?: string[] } | undefined;
    const hasNamespace = this.namespaces.some(
      (n) => n.script === name && n.class === "AppContainer",
    );
    if (!hasNamespace && migrations?.new_sqlite_classes?.[0] !== "AppContainer") {
      return this.error(
        400,
        "Cannot create binding for class AppContainer: no migration declares it",
        10061,
      );
    }
    if (hasNamespace && migrations) {
      return this.error(
        400,
        "Migration tag precondition failed: class AppContainer already exists",
        10079,
      );
    }
    if (!hasNamespace) {
      this.namespaces.push({
        id: this.id("dons"),
        name: `${name}_AppContainer`,
        script: name,
        class: "AppContainer",
      });
    }
    this.scripts.set(name, {
      metadata,
      bindings: Object.fromEntries(bindings.map((b) => [b.name, b])),
      workersDev: existing?.workersDev ?? false,
      uploads: (existing?.uploads ?? 0) + 1,
    });
    return this.ok({ id: name });
  }

  /** The `RH_CONFIG` of the latest upload of a script. */
  config(name: string): { generation: number; deployment_id: string; hostnames: string[] } {
    return JSON.parse(this.scripts.get(name)!.bindings.RH_CONFIG!.text!);
  }

  /** The `RH_RUNTIME_TOKEN` of the latest upload of a script. */
  runtimeToken(name: string): string {
    return this.scripts.get(name)!.bindings.RH_RUNTIME_TOKEN!.text!;
  }

  private async warm(req: Request, url: URL): Promise<Response> {
    const entry: FakeRequest = { method: req.method, path: `${url.hostname}${url.pathname}` };
    this.log.push(entry);
    const script = url.hostname.split(".")[0]!;
    const s = this.scripts.get(script);
    const header = req.headers.get("rh-warm");
    if (!s?.workersDev || !header) return new Response("no route", { status: 404 });
    const { generation } = this.config(script);
    const ts = Number(header.split(".")[0]);
    const expected = await warmHeaderValue(this.runtimeToken(script), generation, ts);
    if (expected !== header) return new Response("no route", { status: 404 });
    return new Response("ok", { status: this.warmStatus });
  }

  private async registry(req: Request, url: URL): Promise<Response> {
    this.log.push({ method: req.method, path: `${url.hostname}${url.pathname}` });
    if (!req.headers.get("authorization")?.startsWith("Basic ")) {
      return Response.json(
        { errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] },
        { status: 401 },
      );
    }
    let m = [] as unknown as RegExpExecArray;
    const at = (re: RegExp, text: string): boolean => {
      const found = re.exec(text);
      if (found) m = found;
      return found !== null;
    };
    if (at(/^\/v2\/(.+)\/tags\/list$/, url.pathname)) {
      return Response.json({ name: m[1], tags: this.tags.get(m[1]!) ?? [] });
    }
    if (at(/^\/v2\/(.+)\/manifests\/(.+)$/, url.pathname)) {
      const repo = m[1]!;
      const ref = decodeURIComponent(m[2]!);
      const tags = this.tags.get(repo) ?? [];
      if (req.method === "HEAD") {
        if (!tags.includes(ref)) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "docker-content-digest": `sha256:${ref}` },
        });
      }
      if (req.method === "DELETE") {
        const tag = ref.replace(/^sha256:/, "");
        this.tags.set(
          repo,
          tags.filter((t) => t !== tag),
        );
        return new Response(null, { status: 202 });
      }
    }
    return Response.json({ errors: [{ code: "NOT_FOUND", message: "unknown" }] }, { status: 404 });
  }
}
