// The Worker's front door: it checks who is calling and hands the request to
// the Durable Object that owns it.
import type { Command } from "./commands"
import { handleInteraction } from "./discord/handle"
import { DiscordRest } from "./discord/rest"
import { readDelivery } from "./github/webhook"

export { Gateway } from "./discord/gateway"
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
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_TOKEN) {
        return new Response("Discord is not configured", { status: 404 })
      }
      const ws = workspace(env)
      const backend = {
        command: (command: Command) => ws.command(command, "discord"),
        suggest: (field: "repo" | "login", typed: string) => ws.suggest(field, typed),
      }
      const rest = new DiscordRest(env.DISCORD_TOKEN)
      return handleInteraction(request, env.DISCORD_PUBLIC_KEY, backend, rest, (work) =>
        ctx.waitUntil(work),
      )
    }
    return new Response("not found", { status: 404 })
  },

  async scheduled(_controller, env): Promise<void> {
    if (env.DISCORD_TOKEN) await env.GATEWAY.getByName("discord").start()
  },
} satisfies ExportedHandler<Env>
