/**
 * Stand-in for the `cloudflare:workers` runtime module, so the runtime
 * Worker's source runs under Node. Mirrors only what `DurableObject`'s
 * constructor does: keep `ctx` and `env`.
 *
 * @module
 */

/** Base class of Durable Objects. */
export class DurableObject<Env = unknown> {
  /** The object's state: storage, alarms and the attached container. */
  ctx: unknown;
  /** The script's bindings. */
  env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
