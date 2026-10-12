// The retro card: what shipped in a day or a week, across projects, and what
// each person did. It goes to a channel the whole org reads, so the summary is
// plain English and the numbers are counts anyone can check on GitHub.
import { peopleStats, type Retro } from "../retro/collect"
import type { Card, Field } from "./card"
import { KIND } from "./glyphs"
import { count, listed } from "./text"

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

/** `label` names a person by GitHub login: a mention that does not notify, or a name. */
export function retroCard(
  retro: Retro,
  summary: string | undefined,
  label: (login: string) => string,
): Card {
  const { period } = retro
  const start = new Date(`${period.first}T00:00:00Z`)
  const title =
    period.kind === "day"
      ? `What shipped on ${DAY.format(start)}`
      : `What shipped the week of ${MONTH_DAY.format(start)}`
  const fields: Field[] = [
    { name: "Merged", value: count(retro.merged.length, "pull request"), inline: true },
    { name: "Closed", value: count(retro.closed.length, "issue"), inline: true },
    {
      name: "Opened",
      value: `${count(retro.opened.pulls, "pull request")}, ${count(retro.opened.issues, "issue")}`,
      inline: true,
    },
  ]
  if (retro.deploys.length > 0) {
    fields.push({ name: "Deploys", value: deployLine(retro), inline: false })
  }
  const people = peopleStats(retro).map((person) => {
    const did = [
      person.merged > 0 ? `${person.merged} merged` : undefined,
      person.reviewed > 0 ? `${person.reviewed} reviewed` : undefined,
      person.closed > 0 ? `${person.closed} closed` : undefined,
    ].filter((part) => part !== undefined)
    return `${label(person.login)} ${did.join(", ")}`
  })
  if (people.length > 0) fields.push({ name: "People", value: people.join("\n"), inline: false })
  return {
    tone: "brand",
    kicker: `${KIND.retro} ${period.kind === "day" ? "Daily" : "Weekly"} retro`,
    title,
    body: summary ?? `A quiet ${period.kind}. Nothing was merged or closed.`,
    fields,
  }
}

/** `3 to production: 2 in web and 1 in ada-api`. */
function deployLine(retro: Retro): string {
  const perRepo = new Map<string, number>()
  for (const deploy of retro.deploys) perRepo.set(deploy.repo, (perRepo.get(deploy.repo) ?? 0) + 1)
  const parts = [...perRepo].map(([repo, n]) => `${n} in ${repo}`)
  return `${retro.deploys.length} to production: ${listed(parts)}`
}
