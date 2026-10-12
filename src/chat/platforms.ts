// The chat platforms whose secrets are set. Each one switches on by itself:
// leave Slack's secrets out and bob runs on Discord alone, and the other way round.
import { DiscordChat } from "../discord/messages"
import { DiscordRest } from "../discord/rest"
import { SlackApi } from "../slack/api"
import { SlackChat } from "../slack/chat"
import type { Platform } from "../store/config"
import type { Chat } from "./chat"

export function chats(env: Env): Chat[] {
  const enabled: Chat[] = []
  if (env.DISCORD_TOKEN) enabled.push(new DiscordChat(new DiscordRest(env.DISCORD_TOKEN)))
  if (env.SLACK_BOT_TOKEN) enabled.push(new SlackChat(new SlackApi(env.SLACK_BOT_TOKEN)))
  return enabled
}

export function chatFor(env: Env, platform: Platform): Chat {
  const chat = chats(env).find((candidate) => candidate.platform === platform)
  if (chat === undefined) throw new Error(`${platform} is not configured`)
  return chat
}
