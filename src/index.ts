// The Worker's front door: it checks who is calling and hands the request to
// the Durable Object that owns it.
import type { Press } from "./chat/press"
import type { Platform } from "./store/config"
import type { Turn } from "./agent/session"
import type { Command } from "./commands"
import { handleInteraction } from "./discord/handle"
import { DiscordRest } from "./discord/rest"
import { readDelivery } from "./github/webhook"
import { SlackApi } from "./slack/api"
import { SlackChat } from "./slack/chat"
import { handleSlack, SLACK_PATHS } from "./slack/handle"

export { Conversation } from "./agent/conversation"
export { Gateway } from "./discord/gateway"
export { Workspace } from "./workspace"

export function workspace(env: Env) {
  return env.WORKSPACE.getByName(env.GITHUB_ORG)
}

function pressIn(
  env: Env,
  platform: Platform,
  press: Press,
  user: Turn["author"],
): Promise<string | undefined> {
  if (!("conversation" in press)) return workspace(env).explain(press.target, platform, user)
  const conversation = env.CONVERSATION.getByName(press.conversation)
  return conversation.press(press.conversation, press.action, press.target, user)
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
        press: (press: Press, user: Turn["author"]) => pressIn(env, "discord", press, user),
      }
      const rest = new DiscordRest(env.DISCORD_TOKEN)
      return handleInteraction(request, env.DISCORD_PUBLIC_KEY, backend, rest, (work) =>
        ctx.waitUntil(work),
      )
    }
    const slack = SLACK_PATHS.get(url.pathname)
    if (slack !== undefined && request.method === "POST") {
      if (!env.SLACK_BOT_TOKEN || !env.SLACK_SIGNING_SECRET) {
        return new Response("Slack is not configured", { status: 404 })
      }
      const ws = workspace(env)
      return handleSlack(slack, {
        request,
        secret: env.SLACK_SIGNING_SECRET,
        chat: new SlackChat(new SlackApi(env.SLACK_BOT_TOKEN)),
        waitUntil: (work) => ctx.waitUntil(work),
        backend: {
          mention: (name, origin, turn) =>
            env.CONVERSATION.getByName(name).mention(name, origin, turn),
          command: (command) => ws.command(command, "slack"),
          press: (press, user) => pressIn(env, "slack", press, user),
        },
      })
    }
    return new Response("not found", { status: 404 })
  },

  async scheduled(_controller, env): Promise<void> {
    if (env.DISCORD_TOKEN) await env.GATEWAY.getByName("discord").start()
  },
} satisfies ExportedHandler<Env>
