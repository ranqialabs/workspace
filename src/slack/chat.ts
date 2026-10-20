// Slack as a chat bob posts to and reads from. Replies always go in a thread:
// `replyTo` is the thread's parent, so news pings thread under their card and
// a conversation stays in the thread it started in.
import { z } from "zod"

import type { Attachment, Chat, ChatMessage, MessageRef, Outgoing, ReadOptions } from "../chat/chat"
import type { SlackApi } from "./api"
import { MARKDOWN_LIMIT, messageBody } from "./blocks"

const Posted = z.object({ ts: z.string(), channel: z.string() })
const UploadUrl = z.object({ upload_url: z.string(), file_id: z.string() })

const Message = z.object({
  ts: z.string(),
  text: z.string().default(""),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  username: z.string().optional(),
})

const History = z.object({ messages: z.array(Message) })

const UserInfo = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    is_admin: z.boolean().optional(),
    is_owner: z.boolean().optional(),
    profile: z
      .object({ display_name: z.string().optional(), real_name: z.string().optional() })
      .optional(),
  }),
})

export interface SlackUser {
  id: string
  name: string
  admin: boolean
}

export class SlackChat implements Chat {
  readonly platform = "slack"
  readonly textLimit = MARKDOWN_LIMIT
  /** Slack notifies no one about an edit, so a ping has to be a message of its own. */
  readonly notifiesOnEdit = false
  private readonly users = new Map<string, Promise<SlackUser>>()

  constructor(private readonly api: SlackApi) {}

  async post(channel: string, message: Outgoing): Promise<MessageRef> {
    const answer = await this.api.call("chat.postMessage", {
      channel,
      ...messageBody(message),
      thread_ts: message.replyTo?.id,
      unfurl_links: false,
    })
    const posted = Posted.parse(answer)
    // Block Kit cannot show a file sent alongside, so the image follows as its own message.
    if (message.attachment !== undefined) {
      await this.upload(posted.channel, message.attachment, message.replyTo?.id)
    }
    return { channel: posted.channel, id: posted.ts }
  }

  private async upload(channel: string, file: Attachment, thread?: string): Promise<void> {
    const target = UploadUrl.parse(
      await this.api.call("files.getUploadURLExternal", {
        filename: file.name,
        length: file.data.length,
        alt_txt: file.alt,
      }),
    )
    await this.api.upload(target.upload_url, file.data)
    await this.api.call("files.completeUploadExternal", {
      files: [{ id: target.file_id, title: file.alt }],
      channel_id: channel,
      thread_ts: thread,
    })
  }

  async edit(ref: MessageRef, message: Outgoing): Promise<void> {
    await this.api.call("chat.update", {
      channel: ref.channel,
      ts: ref.id,
      ...messageBody(message),
    })
  }

  async delete(ref: MessageRef): Promise<void> {
    await this.api.call("chat.delete", { channel: ref.channel, ts: ref.id })
  }

  async read(channel: string, options: ReadOptions): Promise<ChatMessage[]> {
    const limit = Math.min(options.limit, 100)
    const answer =
      options.thread === undefined
        ? await this.api.call("conversations.history", { channel, latest: options.before, limit })
        : await this.api.call("conversations.replies", {
            channel,
            ts: options.thread,
            latest: options.before,
            limit: 200,
          })
    const messages = History.parse(answer).messages.filter(
      (message) => options.before === undefined || Number(message.ts) < Number(options.before),
    )
    // History comes newest first and replies oldest first; both end up oldest first.
    messages.sort((a, b) => Number(a.ts) - Number(b.ts))
    const kept = messages.slice(-limit)
    return Promise.all(kept.map((message) => this.toChatMessage(message)))
  }

  /** A user's display name and whether they administer the workspace; asked once per instance. */
  user(id: string): Promise<SlackUser> {
    let known = this.users.get(id)
    if (known === undefined) {
      known = this.api.call("users.info", { user: id }).then((answer) => {
        const { user } = UserInfo.parse(answer)
        const name = user.profile?.display_name || user.profile?.real_name || user.name
        return { id, name, admin: (user.is_admin ?? false) || (user.is_owner ?? false) }
      })
      known.catch(() => this.users.delete(id))
      this.users.set(id, known)
    }
    return known
  }

  /** The text with `<@U…>` mentions turned into `@name`. */
  async readable(text: string): Promise<string> {
    const ids = [
      ...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1] ?? "")),
    ]
    const names = await Promise.all(
      ids.map((id) =>
        this.user(id).then(
          (user) => user.name,
          () => id,
        ),
      ),
    )
    let readable = text
    for (const [index, id] of ids.entries()) {
      readable = readable.replaceAll(
        new RegExp(`<@${id}(\\|[^>]*)?>`, "g"),
        `@${names[index] ?? id}`,
      )
    }
    return readable.trim()
  }

  private async toChatMessage(message: z.infer<typeof Message>): Promise<ChatMessage> {
    const bot = message.bot_id !== undefined
    const name =
      message.user === undefined
        ? (message.username ?? "a bot")
        : await this.user(message.user).then(
            (user) => user.name,
            () => message.user ?? "someone",
          )
    return {
      id: message.ts,
      author: { id: message.user ?? message.bot_id ?? "", name, bot },
      text: await this.readable(message.text),
      at: new Date(Number(message.ts) * 1000).toISOString(),
    }
  }
}
