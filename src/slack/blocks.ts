// Shared messages as Block Kit. Cards are written in Markdown, which Slack's
// `mrkdwn` reads differently, so card text is converted; a long answer from
// the agent goes in a `markdown` block, which takes Markdown as it is.
import type { Card } from "../ui/card"
import type { Button, Outgoing } from "../chat/chat"

const SECTION_LIMIT = 3000
const MARKDOWN_LIMIT = 12_000
const FIELD_LIMIT = 2000

// Slack's own references: users, channels, groups and special mentions.
const REFERENCE = /(<[@#!][^<>\s]+>)/

/** Markdown as Slack's `mrkdwn`: bold, links and headings, with `&`, `<` and `>` escaped outside references. */
export function mrkdwn(markdown: string): string {
  return markdown
    .split(REFERENCE)
    .map((part) => (REFERENCE.test(part) ? part : convert(escape(part))))
    .join("")
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function convert(text: string): string {
  return text
    .replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
    .replaceAll(/\*\*([^*]+)\*\*/g, "*$1*")
    .replaceAll(/^#{1,6}\s+(.+)$/gm, "*$1*")
}

function link(text: string, url: string | undefined): string {
  return url === undefined ? text : `<${url}|${text}>`
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

export function cardBlocks(card: Card): object[] {
  const kicker = link(escape(card.kicker), card.kickerUrl)
  const title = `*${link(escape(card.title), card.url)}*`
  const blocks: object[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: cut(kicker, SECTION_LIMIT) }] },
    { type: "section", text: { type: "mrkdwn", text: cut(title, SECTION_LIMIT) } },
  ]
  if (card.body !== undefined && card.body !== "") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: cut(mrkdwn(card.body), SECTION_LIMIT) },
    })
  }
  const fields = (card.fields ?? []).slice(0, 10)
  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields: fields.map((field) => ({
        type: "mrkdwn",
        text: cut(`*${field.name}*\n${mrkdwn(field.value)}`, FIELD_LIMIT),
      })),
    })
  }
  if (card.footer !== undefined) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: cut(mrkdwn(card.footer), SECTION_LIMIT) }],
    })
  }
  return blocks
}

const STYLE: Record<NonNullable<Button["style"]>, string | undefined> = {
  primary: "primary",
  secondary: undefined,
  danger: "danger",
}

export function buttonBlock(buttons: Button[]): object {
  return {
    type: "actions",
    elements: buttons.slice(0, 25).map((button) => ({
      type: "button",
      action_id: button.id,
      value: button.id,
      text: { type: "plain_text", text: cut(button.label, 75) },
      style: STYLE[button.style ?? "secondary"],
    })),
  }
}

/** `text` is the notification fallback Slack wants alongside blocks. */
export function messageBody(message: Outgoing): { text: string; blocks: object[] } {
  const blocks: object[] = []
  const text = message.text ?? ""
  if (text !== "") blocks.push({ type: "markdown", text: cut(text, MARKDOWN_LIMIT) })
  for (const card of message.cards ?? []) blocks.push(...cardBlocks(card))
  if (message.buttons !== undefined && message.buttons.length > 0) {
    blocks.push(buttonBlock(message.buttons))
  }
  const fallback =
    text || message.cards?.map((card) => `${card.kicker}: ${card.title}`).join("\n") || " "
  return { text: cut(fallback, SECTION_LIMIT), blocks }
}
