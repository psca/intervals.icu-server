// Minimal stub for cloudflare:workers built-in module.
// Used by vitest (Node.js) so @cloudflare/workers-oauth-provider can be imported
// without the Cloudflare Workers runtime.

export class WorkerEntrypoint {
  env: unknown;
  ctx: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject {
  env: unknown;
  ctx: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcStub {}
export class RpcTarget {}
