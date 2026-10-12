// Answers Slack's three request URLs. Slack wants a 200 within three seconds
// and retries otherwise, so each request is acknowledged at once and the work
// runs after; replies to commands and buttons go to the request's
// `response_url`, which shows them only to whoever ran or pressed.
import { conversationName, type Origin } from "../agent/conversation"
import { type Press, parsePress } from "../chat/press"
import type { Turn } from "../agent/session"
import type { Command } from "../commands"
import type { Reply } from "../ui/commands"
import { REPLY, SLACK_USAGE } from "../ui/replies"
import { messageBody } from "./blocks"
import type { SlackChat } from "./chat"
import {
  BlockActions,
  changes,
  EventEnvelope,
  Mention,
  readSigned,
  SlashCommand,
  toCommand,
} from "./inbound"

export interface SlackBackend {
  mention(name: string, origin: Origin, turn: Turn): Promise<void>
  command(command: Command): Promise<Reply>
  press(press: Press, user: Turn["author"]): Promise<string | undefined>
}

export interface SlackRequest {
  request: Request
  secret: string
  chat: SlackChat
  backend: SlackBackend
  waitUntil(work: Promise<unknown>): void
  /** Posts to a `response_url`; a stub in tests. */
  respond?: (url: string, body: object) => Promise<void>
}

export type SlackKind = "events" | "commands" | "interactions"

export const SLACK_PATHS = new Map<string, SlackKind>([
  ["/slack/events", "events"],
  ["/slack/commands", "commands"],
  ["/slack/interactions", "interactions"],
])

export async function handleSlack(kind: SlackKind, input: SlackRequest) {
  const body = await readSigned(input.request, input.secret)
  if (body instanceof Response) return body
  const respond = input.respond ?? postTo
  if (kind === "events") return event(body, input)
  if (kind === "commands") return command(body, input, respond)
  return interaction(body, input, respond)
}

async function event(body: string, input: SlackRequest): Promise<Response> {
  // A retry means the first delivery is already being answered.
  if (input.request.headers.has("x-slack-retry-num")) return new Response("ok")
  const envelope = EventEnvelope.safeParse(JSON.parse(body))
  if (!envelope.success) return new Response("unreadable event", { status: 400 })
  if (envelope.data.type === "url_verification")
    return Response.json({ challenge: envelope.data.challenge })
  const mention = Mention.safeParse(envelope.data.event)
  const bot = envelope.data.authorizations[0]?.user_id
  if (mention.success && bot !== undefined) {
    input.waitUntil(
      routeMention(mention.data, bot, input).catch((error: unknown) =>
        console.error("slack mention failed", error),
      ),
    )
  }
  return new Response("ok")
}

async function routeMention(mention: Mention, bot: string, input: SlackRequest): Promise<void> {
  const thread = mention.thread_ts ?? mention.ts
  const [author, text] = await Promise.all([
    input.chat.user(mention.user),
    input.chat.readable(mention.text.replaceAll(new RegExp(`<@${bot}(\\|[^>]*)?>`, "g"), "")),
  ])
  const name = conversationName("slack", mention.channel, thread)
  const origin: Origin = {
    platform: "slack",
    scope: [mention.channel],
    link: `https://slack.com/archives/${mention.channel}/p${thread.replace(".", "")}`,
  }
  await input.backend.mention(name, origin, {
    channel: mention.channel,
    thread,
    message: mention.ts,
    author: { id: author.id, name: author.name },
    text: text === "" ? "(no text, just the mention)" : text,
  })
}

function command(
  body: string,
  input: SlackRequest,
  respond: (url: string, body: object) => Promise<void>,
): Response {
  const parsed = SlashCommand.safeParse(Object.fromEntries(new URLSearchParams(body)))
  if (!parsed.success) return new Response("unreadable command", { status: 400 })
  const slash = parsed.data
  const wanted = toCommand(slash)
  if (wanted === undefined) return Response.json({ response_type: "ephemeral", text: SLACK_USAGE })
  input.waitUntil(
    (async () => {
      let reply: Reply
      try {
        const user = await input.chat.user(slash.user_id)
        reply =
          changes(wanted) && !user.admin
            ? { text: REPLY.adminsOnly }
            : await input.backend.command(wanted)
      } catch (error) {
        console.error("slack command failed", error)
        reply = { text: REPLY.broke }
      }
      await respond(slash.response_url, { response_type: "ephemeral", ...messageBody(reply) })
    })(),
  )
  return new Response()
}

function interaction(
  body: string,
  input: SlackRequest,
  respond: (url: string, body: object) => Promise<void>,
): Response {
  const payload = new URLSearchParams(body).get("payload") ?? ""
  const parsed = BlockActions.safeParse(JSON.parse(payload || "{}"))
  if (!parsed.success) return new Response()
  const actions = parsed.data
  const press = parsePress(actions.actions[0]?.action_id ?? "")
  if (press === undefined) return new Response()
  input.waitUntil(
    (async () => {
      let said: string | undefined
      try {
        const user = await input.chat.user(actions.user.id)
        said = await input.backend.press(press, { id: user.id, name: user.name })
      } catch (error) {
        console.error("slack button failed", error)
        said = REPLY.broke
      }
      if (said === undefined || actions.response_url === undefined) return
      await respond(actions.response_url, {
        response_type: "ephemeral",
        replace_original: false,
        text: said,
      })
    })(),
  )
  return new Response()
}

async function postTo(url: string, body: object): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
