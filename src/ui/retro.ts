// The retro's text: what shipped as a changelog, grouped the way release-please
// groups it, with every pull request linked and marked by whether it reached
// production, then what is still open. The numbers are in the image below it.
import type { Item, Retro } from "../retro/collect"
import { type ChangeGroup, changelog, totals } from "../retro/stats"
import type { Card } from "./card"
import { KIND, MARK } from "./glyphs"
import { count, cut } from "./text"

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

/** `label` names a person by GitHub login, as a mention that does not notify or as a name. */
export function retroCard(retro: Retro, label: (login: string) => string, image: boolean): Card {
  const sections: string[] = []
  for (const [group, changes] of changelog(retro)) {
    const shown = changes
      .slice(0, GROUP_LIMIT[group])
      .map(
        ({ pull, subject }) =>
          `- **${short(pull.repo)}** ${subject} [#${pull.number}](${pull.url})${SHIPPED_MARK[pull.shipped]}`,
      )
    const rest = changes.length - shown.length
    if (rest > 0) shown.push(`- and ${rest} more`)
    sections.push(`**${GROUP_TITLE[group]}**\n${shown.join("\n")}`)
  }
  if (sections.length === 0) sections.push(`A quiet ${retro.period.kind}. Nothing was merged.`)
  if (retro.open.length > 0) sections.push(openSection(retro, label))

  const marked = retro.merged.some((pull) => pull.shipped !== "no-deploys")
  const scope = `org:${retro.org}`
  return {
    tone: "brand",
    kicker: `${KIND.retro} ${retro.period.kind === "day" ? "Daily" : "Weekly"} retro`,
    title: title(retro),
    url: searchUrl(`${scope} is:pr is:merged merged:${retro.period.range}`),
    body: cutLines(sections.join("\n\n"), DESCRIPTION_LIMIT),
    image: image ? RETRO_IMAGE : undefined,
    footer: marked
      ? `${KIND.deploy} in production   ${MARK.waiting} waiting for a deploy`
      : undefined,
  }
}

/** What the image says, for whoever can't see it. */
export function retroAlt(retro: Retro): string {
  const sums = totals(retro)
  return [
    `${title(retro)}, ${retro.period.kind === "day" ? "daily" : "weekly"} retro of ${retro.org}.`,
    `${count(sums.merged, "pull request")} merged, ${count(sums.commits, "commit")},`,
    `+${sums.additions} and -${sums.deletions} lines, ${Math.round(retro.ci.minutes)} minutes of CI.`,
  ].join(" ")
}

function openSection(retro: Retro, label: (login: string) => string): string {
  const lines = retro.open.slice(0, OPEN_LIMIT).map((item: Item) => {
    const draft = item.draft ? " (draft)" : ""
    return `- **${short(item.repo)}** ${item.title} [#${item.number}](${item.url}) by ${label(item.author)}${draft}`
  })
  const rest = retro.open.length - lines.length
  if (rest > 0) {
    const query = `org:${retro.org} is:pr is:open created:${retro.period.range}`
    lines.push(`- [and ${rest} more](${searchUrl(query)})`)
  }
  return `**🔀 Still open, ${count(retro.open.length, "pull request")}**\n${lines.join("\n")}`
}

function short(repo: string): string {
  return repo.split("/").at(-1) ?? repo
}

/** Cuts at a line break, so a link is never cut in half. */
function cutLines(text: string, limit: number): string {
  if (text.length <= limit) return text
  const at = text.lastIndexOf("\n", limit - 2)
  return at > 0 ? `${text.slice(0, at)}\n…` : cut(text, limit)
}
