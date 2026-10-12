// A chat that records what bob posted and edited, as one line each.
import type { Chat, ChatMessage, MessageRef, Outgoing, ReadOptions } from "../src/chat/chat"
import type { Platform } from "../src/store/config"

export class FakeChat implements Chat {
  readonly log: string[] = []
  readonly posts: Outgoing[] = []
  readonly edits = new Map<string, Outgoing>()
  history: ChatMessage[] = []
  private next = 1

  constructor(readonly platform: Platform) {}

  post(channel: string, message: Outgoing): Promise<MessageRef> {
    const id = `m${this.next++}`
    const reply = message.replyTo === undefined ? "" : ` ↩${message.replyTo.id}`
    this.log.push(`post ${channel}/${id}${reply} ${describe(message)}`)
    this.posts.push(message)
    return Promise.resolve({ channel, id })
  }

  edit(ref: MessageRef, message: Outgoing): Promise<void> {
    this.log.push(`edit ${ref.channel}/${ref.id} ${describe(message)}`)
    this.edits.set(ref.id, message)
    return Promise.resolve()
  }

  read(channel: string, options: ReadOptions): Promise<ChatMessage[]> {
    this.log.push(`read ${channel} before ${options.before ?? "-"}`)
    return Promise.resolve(this.history.slice(-options.limit))
  }
}

function describe(message: Outgoing): string {
  const card = message.cards?.[0]
  return [message.text, card?.kicker].filter((part) => part !== undefined).join(" | ")
}
