// The retro's text: the model's reading of the work when there is one, then
// what shipped as a changelog, grouped the way release-please
// groups it, with every pull request linked and marked by whether it reached
// production, then what is still open. The numbers are in the image below it.
import type { Item, Retro } from "../retro/collect"
import { type Change, type ChangeGroup, changelog, totals } from "../retro/stats"
import type { Summary } from "../retro/summary"
import type { Card } from "./card"
import { KIND, MARK } from "./glyphs"
import { compact, count, cut, duration, repoName } from "./text"

export const RETRO_IMAGE = "retro.png"

const GROUP_TITLE: Record<ChangeGroup, string> = {
  breaking: "💥 Breaking changes",
  features: "✨ Features",
  fixes: "🐛 Fixes",
  performance: "⚡ Performance",
  maintenance: "🧹 Maintenance",
}
// Features and fixes are the news; housekeeping gets fewer lines.
const GROUP_LIMIT: Record<ChangeGroup, number> = {
  breaking: 8,
  features: 8,
  fixes: 8,
  performance: 5,
  maintenance: 4,
}
const OPEN_LIMIT = 6
const DESCRIPTION_LIMIT = 4000
const CONTINUED = "**The rest of the list is in the reply below.**"

const SHIPPED_MARK = {
  production: ` ${KIND.deploy}`,
  waiting: ` ${MARK.waiting}`,
  "no-deploys": "",
}

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
})
const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
})

/** `Monday, October 12`, or `Week of October 12`. */
export function periodName(retro: Retro): string {
  const start = new Date(`${retro.period.first}T00:00:00Z`)
  return retro.period.kind === "day" ? DAY.format(start) : `Week of ${MONTH_DAY.format(start)}`
}

function title(retro: Retro): string {
  const start = new Date(`${retro.period.first}T00:00:00Z`)
  return retro.period.kind === "day"
    ? `What shipped on ${DAY.format(start)}`
    : `What shipped the week of ${MONTH_DAY.format(start)}`
}

/** GitHub's own search for the same thing, so a count can be checked. */
export function searchUrl(query: string): string {
  return `https://github.com/search?q=${encodeURIComponent(query)}&type=pullrequests`
}

export interface RetroPost {
  card: Card
  /** The sections that did not fit in the card, worded for a follow-up message. */
  rest?: string
}

/** `label` names a person by GitHub login, as a mention that does not notify or as a name. */
export function retroPost(
  retro: Retro,
  label: (login: string) => string,
  image: boolean,
  summary?: Summary,
): RetroPost {
  const sections: string[] = []
  if (retro.merged.length === 0) {
    sections.push(`A quiet ${retro.period.kind}. Nothing was merged.`)
  } else {
    if (summary !== undefined) sections.push(summarySection(summary))
    sections.push(statsSection(retro))
    for (const [group, changes] of changelog(retro)) sections.push(groupSection(group, changes))
    if (retro.open.length > 0) sections.push(openSection(retro, label))
  }

  // Discord caps an embed at 4096 characters. Whole sections go into the card
  // until it is full; the rest follows as a reply instead of being cut off.
  const room = DESCRIPTION_LIMIT - CONTINUED.length - 2
  const packed: string[] = []
  const overflow: string[] = []
  let used = 0
  let full = false
  for (const section of sections) {
    const size = packed.length === 0 ? section.length : used + 2 + section.length
    if (!full && (packed.length === 0 || size <= room)) {
      packed.push(section)
      used = size
    } else {
      // From the first section that does not fit, everything follows in the
      // reply, so the two messages still read in order.
      full = true
      overflow.push(section)
    }
  }
  const body =
    overflow.length === 0
      ? packed.join("\n\n")
      : `${cutLines(packed.join("\n\n"), room)}\n\n${CONTINUED}`

  const marked = retro.merged.some((pull) => pull.shipped !== "no-deploys")
  const scope = `org:${retro.org}`
  return {
    card: {
      tone: "brand",
      kicker: `${KIND.retro} ${retro.period.kind === "day" ? "Daily" : "Weekly"} retro`,
      title: title(retro),
      url: searchUrl(`${scope} is:pr is:merged merged:${retro.period.range}`),
      body,
      image: image ? RETRO_IMAGE : undefined,
      footer: marked
        ? `${KIND.deploy} in production   ${MARK.waiting} waiting for a deploy`
        : undefined,
    },
    rest: overflow.length === 0 ? undefined : overflow.join("\n\n"),
  }
}

function groupSection(group: ChangeGroup, changes: Change[]): string {
  const shown = changes
    .slice(0, GROUP_LIMIT[group])
    .map(
      ({ pull, subject }) =>
        `- **${repoName(pull.repo)}** ${subject} [#${pull.number}](${pull.url})${SHIPPED_MARK[pull.shipped]}`,
    )
  const remaining = changes.length - shown.length
  if (remaining > 0) shown.push(`- and ${remaining} more`)
  return `**${GROUP_TITLE[group]}**\n${shown.join("\n")}`
}

/** The period in one line, so the text carries the numbers even without the picture. */
function statsSection(retro: Retro): string {
  const sums = totals(retro)
  const parts = [
    `**${count(sums.merged, "pull request")} merged**`,
    count(sums.commits, "commit"),
    `+${compact(sums.additions)} / −${compact(sums.deletions)} lines`,
  ]
  if (retro.ci.minutes > 0) parts.push(`${duration(retro.ci.minutes)} of CI`)
  if (sums.inProduction > 0) parts.push(`${sums.inProduction} in production`)
  if (sums.waiting > 0) parts.push(`${sums.waiting} waiting for a deploy`)
  return parts.join(" · ")
}

/** The overview, then a line per theme with the pull requests behind it. */
function summarySection(summary: Summary): string {
  const themes = summary.themes.map((theme) => {
    const links = theme.pulls.map((pull) => `[#${pull.number}](${pull.url})`).join(", ")
    return `- **${theme.title}**: ${theme.meaning} ${links}`
  })
  return [summary.overview, themes.join("\n")].filter((part) => part !== "").join("\n\n")
}

/** What the image says, for whoever can't see it. */
export function retroAlt(retro: Retro, summary?: Summary): string {
  const sums = totals(retro)
  return [
    ...(summary === undefined || summary.overview === "" ? [] : [summary.overview]),
    `${title(retro)}, ${retro.period.kind === "day" ? "daily" : "weekly"} retro of ${retro.org}.`,
    `${count(sums.merged, "pull request")} merged, ${count(sums.commits, "commit")},`,
    `+${sums.additions} and -${sums.deletions} lines, ${Math.round(retro.ci.minutes)} minutes of CI.`,
  ].join(" ")
}

function openSection(retro: Retro, label: (login: string) => string): string {
  const lines = retro.open.slice(0, OPEN_LIMIT).map((item: Item) => {
    const draft = item.draft ? " (draft)" : ""
    return `- **${repoName(item.repo)}** ${item.title} [#${item.number}](${item.url}) by ${label(item.author)}${draft}`
  })
  const rest = retro.open.length - lines.length
  if (rest > 0) {
    const query = `org:${retro.org} is:pr is:open created:${retro.period.range}`
    lines.push(`- [and ${rest} more](${searchUrl(query)})`)
  }
  return `**🔀 Still open, ${count(retro.open.length, "pull request")}**\n${lines.join("\n")}`
}

/** Cuts at a line break, so a link is never cut in half. */
function cutLines(text: string, limit: number): string {
  if (text.length <= limit) return text
  const at = text.lastIndexOf("\n", limit - 2)
  return at > 0 ? `${text.slice(0, at)}\n…` : cut(text, limit)
}
