// The Worker's front door: it checks who is calling and hands the request to
// the Durable Object that owns it.
import { readDelivery } from "./github/webhook"

export { Workspace } from "./workspace"

export function workspace(env: Env) {
  return env.WORKSPACE.getByName(env.GITHUB_ORG)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname === "/github/webhook" && request.method === "POST") {
      const delivery = await readDelivery(request, env.GITHUB_WEBHOOK_SECRET)
      if (delivery instanceof Response) return delivery
      // GitHub gives up after ten seconds; the cards can take longer than that.
      ctx.waitUntil(workspace(env).github(delivery))
      return new Response("accepted", { status: 202 })
    }
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
