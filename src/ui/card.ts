// A message drawn once and shown on either platform. Text is Markdown with
// mentions already in the platform's syntax; each platform turns the rest
// into an embed or Block Kit.

export type Tone = "green" | "grey" | "blue" | "red" | "purple" | "brand"

export interface Field {
  name: string
  value: string
  inline?: boolean
}

export interface Card {
  tone: Tone
  /** The small line above the title: what kind of news, and where. */
  kicker: string
  kickerUrl?: string
  title: string
  url?: string
  body?: string
  fields?: Field[]
  footer?: string
  /** ISO 8601; shown as the platform's relative time. */
  at?: string
}

/** How a platform names people and groups, so a ping actually notifies them. */
export interface Mentions {
  person(login: string): string | undefined
  group(repo: string): string | undefined
}

/** A login as a mention when bob knows who it is on this platform, else as code. */
export function who(mentions: Mentions, login: string): string {
  return mentions.person(login) ?? `\`${login}\``
}
