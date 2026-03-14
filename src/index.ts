export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello World!");
  },
} satisfies ExportedHandler<Env>;

export interface Env {
  API_KEY: string;
  ATHLETE_ID: string;
}
