// Answers Discord's interactions endpoint. Discord wants an answer within three
// seconds, so a command is acknowledged at once and its reply is filled in
// once the Workspace has checked GitHub.
import { type Press, parsePress } from "../chat/press"
import type { Turn } from "../agent/session"
import type { Command } from "../commands"
import type { Reply } from "../ui/commands"
import { REPLY } from "../ui/replies"
import { messageBody } from "./messages"
import { DiscordRest } from "./rest"
import {
  EPHEMERAL,
  focused,
  Interaction,
  InteractionType,
  ResponseType,
  signatureMatches,
  toCommand,
} from "./interactions"

/** What the handler needs from the Workspace; a stub in tests. */
export interface Backend {
  command(command: Command): Promise<Reply>
  suggest(field: "repo" | "login", typed: string): Promise<string[]>
  /** A button on one of bob's messages; resolves to what to tell the presser, if anything. */
  press(press: Press, user: Turn["author"]): Promise<string | undefined>
}

export async function handleInteraction(
  request: Request,
  publicKey: string,
  backend: Backend,
  rest: DiscordRest,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> {
  const body = await request.text()
  const signature = request.headers.get("x-signature-ed25519")
  const timestamp = request.headers.get("x-signature-timestamp")
  if (!(await signatureMatches(publicKey, body, signature, timestamp))) {
    return new Response("bad signature", { status: 401 })
  }
  const parsed = Interaction.safeParse(JSON.parse(body))
  if (!parsed.success) return new Response("unreadable interaction", { status: 400 })
  const interaction = parsed.data

  switch (interaction.type) {
    case InteractionType.ping:
      return Response.json({ type: ResponseType.pong })
    case InteractionType.autocomplete:
      return Response.json({
        type: ResponseType.autocomplete,
        data: { choices: await choices(interaction, backend) },
      })
    case InteractionType.command: {
      const command = toCommand(interaction)
      if (command === undefined) return ephemeral(REPLY.unknownCommand)
      waitUntil(reply(interaction, rest, () => backend.command(command)))
      return Response.json({ type: ResponseType.deferredMessage, data: { flags: EPHEMERAL } })
    }
    case InteractionType.component: {
      const press = parsePress(interaction.data?.custom_id ?? "")
      const user = interaction.member?.user ?? interaction.user
      if (press === undefined || user === undefined) return ephemeral(REPLY.foreignButton)
      const author = { id: user.id, name: user.global_name ?? user.username }
      waitUntil(tell(interaction, rest, () => backend.press(press, author)))
      return Response.json({ type: ResponseType.deferredUpdate })
    }
    default:
      return ephemeral(REPLY.unsupported)
  }
}

async function choices(interaction: Interaction, backend: Backend) {
  const field = focused(interaction)
  if (field?.name !== "repo" && field?.name !== "login") return []
  const names = await backend.suggest(field.name, field.value)
  return names.map((name) => ({ name, value: name }))
}

/** Fills in the deferred answer; a failure is said there rather than left spinning. */
async function reply(interaction: Interaction, rest: DiscordRest, work: () => Promise<Reply>) {
  const route = `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`
  try {
    const { text, cards } = await work()
    const { message_reference: _, ...body } = messageBody({ text, cards })
    await rest.patch(route, body)
  } catch (error) {
    console.error("discord command failed", error)
    await rest.patch(route, { content: REPLY.broke })
  }
}

/** A private follow-up for whoever pressed a button, when there is something to say. */
async function tell(
  interaction: Interaction,
  rest: DiscordRest,
  work: () => Promise<string | undefined>,
): Promise<void> {
  let said: string | undefined
  try {
    said = await work()
  } catch (error) {
    console.error("discord button failed", error)
    said = REPLY.broke
  }
  if (said === undefined) return
  await rest.post(`/webhooks/${interaction.application_id}/${interaction.token}`, {
    content: said,
    flags: EPHEMERAL,
  })
}

function ephemeral(content: string): Response {
  return Response.json({ type: ResponseType.message, data: { content, flags: EPHEMERAL } })
}
