// The retro as a picture: what the work meant when a model read it, the
// period's numbers in a ledger, when each pull
// request merged, where the work landed and where it stands, who did it, and a
// few highlights. It is a tree satori lays out; nothing here draws pixels, so a
// test can read the tree. No emoji: satori would need a font for them.
import type { Merged, Retro } from "../retro/collect"
import {
  type ChangeGroup,
  CHANGE_ORDER,
  changeOf,
  highlights,
  type HighlightKind,
  peopleStats,
  type PersonStats,
  repoStats,
  type Totals,
  totals,
} from "../retro/stats"
import type { Summary, Theme } from "../retro/summary"
import { PALETTE } from "./palette"
import { periodName } from "./retro"
import { compact, count, cut, duration, repoName } from "./text"
import { h, type Node } from "./tree"

export const WIDTH = 1440
const PADDING = 64
const CONTENT = WIDTH - PADDING * 2

export interface Face {
  login: string
  name: string
  /** A data URL; without one the person gets their initial. */
  avatar?: string
}

const NUMBER = new Intl.NumberFormat("en-US")
const MAX_PEOPLE = 6
const MAX_REPOS = 5
const HOUR = 3_600_000

const HIGHLIGHT_LABEL: Record<HighlightKind, string> = {
  biggest: "Biggest change",
  talked: "Most talked about",
  fastest: "Fastest merge",
}

const CHANGE_COLOR: Record<ChangeGroup, string> = {
  breaking: PALETTE.red,
  features: PALETTE.pink,
  fixes: PALETTE.gold[1],
  performance: PALETTE.green,
  maintenance: PALETTE.faint,
}

function changeCount(group: ChangeGroup, n: number): string {
  if (group === "features") return count(n, "feature")
  if (group === "fixes") return count(n, "fix", "fixes")
  return `${n} ${group}`
}

/**
 * The image's tree; satori works out its height from what is in it. `brief`
 * drops the summary, timeline and panels, leaving the numbers, the people and
 * the highlights for when the full picture is too expensive to draw.
 */
export function retroImage(
  retro: Retro,
  faces: Map<string, Face>,
  summary?: Summary,
  brief = false,
): Node {
  const sums = totals(retro)
  const people = peopleStats(retro).slice(0, MAX_PEOPLE)
  const notes = highlights(retro)
  const sections: Node[] = [header(retro)]
  if (!brief && summary !== undefined) sections.push(summarySection(summary))

  if (retro.merged.length === 0) {
    sections.push(
      h(
        "div",
        { fontSize: 44, fontWeight: 700, color: PALETTE.muted, marginTop: 56 },
        `A quiet ${retro.period.kind}. Nothing was merged.`,
      ),
    )
  } else {
    sections.push(ledger(retro, sums))
    if (!brief) {
      sections.push(timeline(retro))
      sections.push(
        h("div", { marginTop: 56, gap: 48 }, reposPanel(retro), pullsPanel(retro, sums)),
      )
    }
  }
  if (people.length > 0) sections.push(peopleTable(people, faces))
  if (notes.length > 0) {
    sections.push(
      h(
        "div",
        { marginTop: 56, gap: 20 },
        ...notes.map((note) => highlightTile(note.kind, note.pull)),
      ),
    )
  }
  return h(
    "div",
    {
      flexDirection: "column",
      width: WIDTH,
      padding: PADDING,
      backgroundColor: PALETTE.background,
      backgroundImage: `radial-gradient(circle at 100% 0%, ${PALETTE.glow}, transparent 45%), radial-gradient(circle at 0% 100%, ${PALETTE.glowPink}, transparent 40%)`,
      color: PALETTE.text,
      fontFamily: "Space Grotesk",
    },
    ...sections,
  )
}

function header(retro: Retro): Node {
  return h(
    "div",
    { justifyContent: "space-between", alignItems: "flex-end" },
    h(
      "div",
      { flexDirection: "column" },
      h("div", { fontSize: 64, fontWeight: 700, letterSpacing: -1.5 }, periodName(retro)),
      h(
        "div",
        { fontSize: 28, fontWeight: 500, color: PALETTE.muted, marginTop: 4 },
        retro.period.kind === "day" ? "Daily retro" : "Weekly retro",
      ),
    ),
    h("div", { fontSize: 26, fontWeight: 500, color: PALETTE.faint }, retro.org),
  )
}

/** The four numbers, each in a column of its own so labels never run together. */
function ledger(retro: Retro, sums: Totals): Node {
  const opened = retro.open.length > 0 ? `${retro.open.length} still open` : "none left open"
  const ci =
    retro.ci.failed > 0
      ? `${count(retro.ci.runs, "run")}, ${retro.ci.failed} failed`
      : `${count(retro.ci.runs, "run")}, all green`
  return h(
    "div",
    { marginTop: 56 },
    ledgerColumn(
      String(sums.merged),
      sums.merged === 1 ? "pull request merged" : "pull requests merged",
      [opened],
      PALETTE.pink,
      true,
    ),
    ledgerColumn(NUMBER.format(sums.commits), "commits", [`in ${count(sums.files, "file")}`]),
    ledgerColumn(compact(sums.additions + sums.deletions), "lines changed", [
      h("span", { color: PALETTE.green }, `+${compact(sums.additions)}`),
      h("span", { color: PALETTE.red }, `−${compact(sums.deletions)}`),
    ]),
    ledgerColumn(duration(retro.ci.minutes), "in CI", [ci]),
  )
}

function ledgerColumn(
  value: string,
  label: string,
  detail: (Node | string)[],
  color: string = PALETTE.text,
  first = false,
): Node {
  return h(
    "div",
    {
      flexDirection: "column",
      width: CONTENT / 4,
      paddingLeft: first ? 0 : 28,
      borderLeft: first ? "none" : `1px solid ${PALETTE.line}`,
    },
    h("div", { fontSize: 64, fontWeight: 700, color, letterSpacing: -2, lineHeight: 1 }, value),
    h("div", { fontSize: 24, fontWeight: 500, marginTop: 12 }, label),
    h("div", { fontSize: 22, color: PALETTE.muted, marginTop: 4, gap: 10 }, ...detail),
  )
}

/** Each merge as a dot on the period's clock: colour for its kind, size for its lines. */
function timeline(retro: Retro): Node {
  const { period } = retro
  const day = period.kind === "day"
  const at = (pull: Merged): number => (pull.mergedAt - period.from) / HOUR
  const hours = retro.merged.map(at)
  // A day shows working hours, stretched to whatever merged outside them.
  const start = day ? Math.max(0, Math.min(8, Math.floor(Math.min(...hours)))) : 0
  const end = day ? Math.min(24, Math.max(20, Math.ceil(Math.max(...hours)))) : 7 * 24
  const x = (hour: number): number =>
    ((Math.min(end, Math.max(start, hour)) - start) / (end - start)) * CONTENT
  const biggest = Math.max(...retro.merged.map((pull) => pull.additions + pull.deletions), 1)

  // A day marks every other hour under its label; a week marks midnights and
  // names each day in the middle of its stretch.
  const marks: number[] = []
  const ticks: { at: number; label: string }[] = []
  if (day) {
    for (let hour = Math.ceil(start / 2) * 2; hour <= end; hour += 2) {
      marks.push(x(hour))
      ticks.push({ at: x(hour), label: `${String(hour % 24).padStart(2, "0")}:00` })
    }
  } else {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for (let index = 0; index <= 7; index += 1) marks.push(x(index * 24))
    names.forEach((label, index) => ticks.push({ at: x(index * 24 + 12), label }))
  }

  const track = 80
  const dots = retro.merged
    .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .map((pull) => {
      const size = Math.round(16 + 36 * Math.sqrt((pull.additions + pull.deletions) / biggest))
      const left = Math.min(CONTENT - size, Math.max(0, x(at(pull)) - size / 2))
      return h("div", {
        position: "absolute",
        left,
        top: track / 2 - size / 2,
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: CHANGE_COLOR[changeOf(pull.title).group],
        border: `3px solid ${PALETTE.background}`,
      })
    })

  const kinds = new Map<ChangeGroup, number>()
  for (const pull of retro.merged) {
    const { group } = changeOf(pull.title)
    kinds.set(group, (kinds.get(group) ?? 0) + 1)
  }
  const legend = CHANGE_ORDER.filter((group) => kinds.has(group)).map((group) =>
    swatch(CHANGE_COLOR[group], changeCount(group, kinds.get(group) ?? 0)),
  )

  return h(
    "div",
    { flexDirection: "column", marginTop: 56 },
    h(
      "div",
      { justifyContent: "space-between", alignItems: "center" },
      sectionTitle(day ? "When it merged" : "When it merged, by day"),
      h("div", { gap: 24 }, ...legend),
    ),
    h(
      "div",
      { position: "relative", width: CONTENT, height: track, marginTop: 8 },
      h("div", {
        position: "absolute",
        left: 0,
        top: track / 2 - 1,
        width: CONTENT,
        height: 2,
        backgroundColor: PALETTE.line,
      }),
      ...marks.map((mark) =>
        h("div", {
          position: "absolute",
          left: Math.min(CONTENT - 2, mark),
          top: track / 2 - 6,
          width: 2,
          height: 12,
          backgroundColor: PALETTE.line,
        }),
      ),
      ...dots,
    ),
    h(
      "div",
      { position: "relative", width: CONTENT, height: 28 },
      ...ticks.map((tick) =>
        h(
          "div",
          {
            position: "absolute",
            left: Math.min(CONTENT - 80, Math.max(0, tick.at - 40)),
            width: 80,
            // The ends hug the edges so the label still sits on its tick.
            justifyContent:
              tick.at < 40 ? "flex-start" : tick.at > CONTENT - 40 ? "flex-end" : "center",
            fontSize: 20,
            color: PALETTE.faint,
          },
          tick.label,
        ),
      ),
    ),
  )
}

function reposPanel(retro: Retro): Node {
  const repos = repoStats(retro)
  const shown = repos.slice(0, MAX_REPOS)
  const top = Math.max(...shown.map((repo) => repo.additions + repo.deletions), 1)
  const rest = repos.length - shown.length
  return h(
    "div",
    { flexDirection: "column", flex: 1, gap: 22 },
    sectionTitle(repos.length === 1 ? "Repository" : `${repos.length} repositories`),
    ...shown.map((repo) =>
      h(
        "div",
        { flexDirection: "column", gap: 8 },
        h(
          "div",
          { justifyContent: "space-between", alignItems: "baseline", fontSize: 24 },
          h("div", { fontWeight: 700 }, repoName(repo.repo)),
          h(
            "div",
            { gap: 12, color: PALETTE.muted },
            h("span", {}, count(repo.merged, "PR")),
            h("span", { color: PALETTE.green }, `+${compact(repo.additions)}`),
            h("span", { color: PALETTE.red }, `−${compact(repo.deletions)}`),
          ),
        ),
        // Linear, with a sliver for the smallest, so a one-line fix still shows up.
        h("div", {
          width: `${Math.max(2, ((repo.additions + repo.deletions) / top) * 100)}%`,
          height: 8,
          borderRadius: 999,
          backgroundImage: `linear-gradient(90deg, ${PALETTE.gold[0]}, ${PALETTE.gold[2]})`,
        }),
      ),
    ),
    ...(rest > 0 ? [h("div", { fontSize: 22, color: PALETTE.faint }, `and ${rest} more`)] : []),
  )
}

/** Where the merged pull requests stand, then how they got there. */
function pullsPanel(retro: Retro, sums: Totals): Node {
  const noDeploys = sums.merged - sums.inProduction - sums.waiting
  const states: [number, string, string][] = [
    [sums.inProduction, PALETTE.pink, "in production"],
    [sums.waiting, PALETTE.gold[1], "waiting for a deploy"],
    [noDeploys, PALETTE.faint, "in repos without deploys"],
  ]
  const shown = states.filter(([n]) => n > 0)
  const facts: [string, string][] = []
  if (sums.medianMinutesToMerge !== undefined) {
    facts.push(["Median time to merge", duration(sums.medianMinutesToMerge)])
  }
  facts.push(["Reviews", NUMBER.format(sums.reviews)])
  facts.push(["Comments", NUMBER.format(sums.comments)])
  facts.push([
    "Opened",
    `${count(retro.opened.pulls, "PR")}, ${count(retro.opened.issues, "issue")}`,
  ])
  facts.push(["Issues closed", NUMBER.format(retro.closed.length)])
  if (retro.deploys.length > 0) {
    facts.push(["Production deploys", NUMBER.format(retro.deploys.length)])
  }
  return h(
    "div",
    { flexDirection: "column", flex: 1, gap: 18 },
    sectionTitle("Where the merged work is"),
    h(
      "div",
      { height: 16, borderRadius: 999, overflow: "hidden", gap: 4, marginTop: 4 },
      ...shown.map(([n, color]) => h("div", { flex: n, height: 16, backgroundColor: color })),
    ),
    h(
      "div",
      { flexDirection: "column", gap: 6 },
      ...shown.map(([n, color, label]) => swatch(color, `${n} ${label}`)),
    ),
    h(
      "div",
      { flexDirection: "column", gap: 10, marginTop: 10 },
      ...facts.map(([label, value]) =>
        h(
          "div",
          { justifyContent: "space-between", fontSize: 22 },
          h("div", { color: PALETTE.muted }, label),
          h("div", { fontWeight: 500 }, value),
        ),
      ),
    ),
  )
}

const COLUMNS = { prs: 90, commits: 130, lines: 220, reviews: 120 } as const

/** One row each, the numbers in columns so they line up across people. */
function peopleTable(people: PersonStats[], faces: Map<string, Face>): Node {
  const anyClosed = people.some((person) => person.closed > 0)
  return h(
    "div",
    { flexDirection: "column", marginTop: 56, gap: 16 },
    h(
      "div",
      { alignItems: "flex-end" },
      h("div", { flex: 1 }, sectionTitle("People")),
      heading("PRs", COLUMNS.prs),
      heading("Commits", COLUMNS.commits),
      heading("Lines", COLUMNS.lines),
      heading("Reviews", COLUMNS.reviews),
      ...(anyClosed ? [heading("Issues", COLUMNS.reviews)] : []),
    ),
    ...people.map((person) => personRow(person, faces.get(person.login), anyClosed)),
  )
}

function personRow(person: PersonStats, face: Face | undefined, anyClosed: boolean): Node {
  const name = face?.name ?? person.login
  return h(
    "div",
    { alignItems: "center" },
    h(
      "div",
      { flex: 1, alignItems: "center", gap: 18 },
      avatar(name, face?.avatar),
      h(
        "div",
        { flexDirection: "column" },
        h("div", { fontSize: 26, fontWeight: 700 }, name),
        ...(name.toLowerCase() === person.login.toLowerCase()
          ? []
          : [h("div", { fontSize: 20, color: PALETTE.faint }, person.login)]),
      ),
    ),
    cell(COLUMNS.prs, quiet(person.merged)),
    cell(COLUMNS.commits, quiet(person.commits)),
    cell(
      COLUMNS.lines,
      ...(person.additions + person.deletions === 0
        ? [h("span", { color: PALETTE.faint }, "0")]
        : [
            h("span", { color: PALETTE.green }, `+${compact(person.additions)}`),
            h("span", { color: PALETTE.red }, `−${compact(person.deletions)}`),
          ]),
    ),
    cell(COLUMNS.reviews, quiet(person.reviewed)),
    ...(anyClosed ? [cell(COLUMNS.reviews, quiet(person.closed))] : []),
  )
}

function heading(text: string, width: number): Node {
  return h("div", { width, justifyContent: "flex-end", fontSize: 20, color: PALETTE.faint }, text)
}

function cell(width: number, ...children: (Node | string)[]): Node {
  return h("div", { width, justifyContent: "flex-end", gap: 10, fontSize: 26 }, ...children)
}

/** A count, dimmed when it is zero. */
function quiet(n: number): Node {
  return h("span", { color: n === 0 ? PALETTE.faint : PALETTE.text }, NUMBER.format(n))
}

function avatar(name: string, src: string | undefined): Node {
  const size = 52
  if (src !== undefined) {
    return { type: "img", props: { src, style: { width: size, height: size, borderRadius: 999 } } }
  }
  return h(
    "div",
    {
      width: size,
      height: size,
      borderRadius: 999,
      backgroundColor: PALETTE.pinkDeep,
      alignItems: "center",
      justifyContent: "center",
      fontSize: 24,
      fontWeight: 700,
    },
    (name[0] ?? "?").toUpperCase(),
  )
}

function highlightTile(kind: HighlightKind, pull: Merged): Node {
  const value =
    kind === "talked"
      ? [h("span", {}, count(pull.comments, "comment"))]
      : kind === "fastest"
        ? [h("span", {}, duration(pull.minutesToMerge))]
        : [
            h("span", { color: PALETTE.green }, `+${compact(pull.additions)}`),
            h("span", { color: PALETTE.red }, `−${compact(pull.deletions)}`),
          ]
  return h(
    "div",
    {
      flexDirection: "column",
      flex: 1,
      padding: "22px 24px",
      borderRadius: 20,
      backgroundColor: PALETTE.surface,
      border: `1px solid ${PALETTE.line}`,
    },
    h("div", { fontSize: 20, color: PALETTE.muted }, HIGHLIGHT_LABEL[kind]),
    h("div", { fontSize: 30, fontWeight: 700, marginTop: 6, gap: 10 }, ...value),
    h(
      "div",
      { fontSize: 22, lineHeight: 1.35, marginTop: 10, color: PALETTE.text },
      cut(changeOf(pull.title).subject, 64),
    ),
    h(
      "div",
      { fontSize: 20, color: PALETTE.faint, marginTop: 8, gap: 8 },
      h("span", { color: PALETTE.pink }, `#${pull.number}`),
      repoName(pull.repo),
    ),
  )
}

/** The overview in large type, then each theme with what it means and its pull requests. */
function summarySection(summary: Summary): Node {
  const column = (CONTENT - 48) / 2
  return h(
    "div",
    { flexDirection: "column", marginTop: 48 },
    ...(summary.overview === ""
      ? []
      : [
          h(
            "div",
            { fontSize: 36, fontWeight: 500, lineHeight: 1.3, maxWidth: 1120, letterSpacing: -0.5 },
            cut(summary.overview, 280),
          ),
        ]),
    ...(summary.themes.length === 0
      ? []
      : [
          h(
            "div",
            { flexWrap: "wrap", columnGap: 48, rowGap: 32, marginTop: 40 },
            ...summary.themes.map((theme) => themeBlock(theme, column)),
          ),
        ]),
  )
}

function themeBlock(theme: Theme, width: number): Node {
  // The stripe takes the weightiest kind among its pull requests, as on the timeline.
  const groups = new Set(theme.pulls.map((pull) => changeOf(pull.title).group))
  const group = CHANGE_ORDER.find((candidate) => groups.has(candidate)) ?? "maintenance"
  const refs = theme.pulls.slice(0, 4)
  const rest = theme.pulls.length - refs.length
  return h(
    "div",
    {
      flexDirection: "column",
      width,
      paddingLeft: 22,
      borderLeft: `4px solid ${CHANGE_COLOR[group]}`,
    },
    h("div", { fontSize: 28, fontWeight: 700, lineHeight: 1.2 }, cut(theme.title, 48)),
    h(
      "div",
      { fontSize: 23, color: PALETTE.muted, lineHeight: 1.4, marginTop: 8 },
      cut(theme.meaning, 180),
    ),
    h(
      "div",
      { flexWrap: "wrap", columnGap: 18, rowGap: 4, marginTop: 10, fontSize: 20 },
      ...refs.map((pull) =>
        h(
          "div",
          { gap: 6, color: PALETTE.faint },
          h("span", { color: PALETTE.pink }, `#${pull.number}`),
          repoName(pull.repo),
        ),
      ),
      ...(rest > 0 ? [h("div", { color: PALETTE.faint }, `and ${rest} more`)] : []),
    ),
  )
}

function sectionTitle(text: string): Node {
  return h("div", { fontSize: 22, fontWeight: 500, color: PALETTE.muted }, text)
}

function swatch(color: string, text: string): Node {
  return h(
    "div",
    { alignItems: "center", gap: 10, fontSize: 22, color: PALETTE.text },
    h("div", { width: 12, height: 12, borderRadius: 3, backgroundColor: color }),
    text,
  )
}
