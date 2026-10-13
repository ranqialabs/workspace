// The retro as a picture: the numbers big, each person's share as a bar, and
// a few highlights. It is a tree satori lays out; nothing here draws pixels,
// so a test can read the tree. No emoji: satori would need a font for them.
import type { Merged, Retro } from "../retro/collect"
import {
  activity,
  highlights,
  type HighlightKind,
  peopleStats,
  type PersonStats,
  type Totals,
  totals,
} from "../retro/stats"
import { PALETTE } from "./palette"
import { periodName } from "./retro"
import { compact, count, duration, lineDelta, repoName } from "./text"
import { h, type Node } from "./tree"

export const WIDTH = 1200

export interface Face {
  login: string
  name: string
  /** A data URL; without one the person gets their initial. */
  avatar?: string
}

const NUMBER = new Intl.NumberFormat("en-US")
const MAX_PEOPLE = 6

const HIGHLIGHT_LABEL: Record<HighlightKind, string> = {
  biggest: "Biggest change",
  talked: "Most talked about",
  fastest: "Fastest merge",
}

/** The image's tree; satori works out its height from what is in it. */
export function retroImage(retro: Retro, faces: Map<string, Face>): Node {
  const sums = totals(retro)
  const people = peopleStats(retro).slice(0, MAX_PEOPLE)
  const notes = highlights(retro)
  const sections: Node[] = [header(retro)]

  if (retro.merged.length === 0) {
    sections.push(
      h(
        "div",
        { fontSize: 44, fontWeight: 700, color: PALETTE.muted, marginTop: 56 },
        `A quiet ${retro.period.kind}. Nothing was merged.`,
      ),
    )
  } else {
    sections.push(bigNumbers(retro, sums))
    sections.push(chips(retro, sums))
  }
  if (people.length > 0) {
    const top = Math.max(...people.map(activity), 1)
    sections.push(
      h(
        "div",
        { flexDirection: "column", marginTop: 48, gap: 18 },
        ...people.map((person) =>
          personRow(person, faces.get(person.login), activity(person) / top),
        ),
      ),
    )
  }
  if (notes.length > 0) {
    sections.push(
      h(
        "div",
        { marginTop: 48, gap: 20 },
        ...notes.map((note) => highlightTile(note.kind, note.pull)),
      ),
    )
  }
  return h(
    "div",
    {
      flexDirection: "column",
      width: WIDTH,
      padding: 64,
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

function bigNumbers(retro: Retro, sums: Totals): Node {
  const ci = `${NUMBER.format(Math.round(retro.ci.minutes))} min`
  const ciLabel =
    retro.ci.failed > 0
      ? `CI, ${retro.ci.runs} runs, ${retro.ci.failed} failed`
      : `CI, ${retro.ci.runs} runs`
  return h(
    "div",
    { marginTop: 56, justifyContent: "space-between" },
    stat(
      String(sums.merged),
      sums.merged === 1 ? "pull request merged" : "pull requests merged",
      PALETTE.pink,
    ),
    stat(NUMBER.format(sums.commits), "commits"),
    h(
      "div",
      { flexDirection: "column" },
      h(
        "div",
        { fontSize: 72, fontWeight: 700, gap: 16, letterSpacing: -2, lineHeight: 1 },
        h("span", { color: PALETTE.green }, `+${compact(sums.additions)}`),
        h("span", { color: PALETTE.red }, `−${compact(sums.deletions)}`),
      ),
      h(
        "div",
        { fontSize: 24, color: PALETTE.muted, marginTop: 10 },
        `lines in ${NUMBER.format(sums.files)} files`,
      ),
    ),
    stat(ci, ciLabel),
  )
}

function stat(value: string, label: string, color: string = PALETTE.text): Node {
  return h(
    "div",
    { flexDirection: "column" },
    h("div", { fontSize: 72, fontWeight: 700, color, letterSpacing: -2, lineHeight: 1 }, value),
    h("div", { fontSize: 24, color: PALETTE.muted, marginTop: 10 }, label),
  )
}

function chips(retro: Retro, sums: Totals): Node {
  const items: [string, string | undefined][] = []
  if (sums.inProduction > 0) items.push([`${sums.inProduction} in production`, PALETTE.pink])
  if (sums.waiting > 0) items.push([`${sums.waiting} waiting for a deploy`, PALETTE.gold[1]])
  items.push([`${NUMBER.format(sums.comments)} comments`, undefined])
  items.push([`${NUMBER.format(sums.reviews)} reviews`, undefined])
  if (sums.medianMinutesToMerge !== undefined) {
    items.push([`${duration(sums.medianMinutesToMerge)} median to merge`, undefined])
  }
  if (retro.open.length > 0) items.push([`${retro.open.length} still open`, undefined])
  return h(
    "div",
    { marginTop: 40, gap: 12, flexWrap: "wrap" },
    ...items.map(([text, dot]) =>
      h(
        "div",
        {
          alignItems: "center",
          gap: 10,
          padding: "10px 20px",
          borderRadius: 999,
          backgroundColor: PALETTE.surface,
          border: `1px solid ${PALETTE.line}`,
          fontSize: 24,
          color: PALETTE.text,
        },
        ...(dot === undefined
          ? []
          : [h("div", { width: 12, height: 12, borderRadius: 999, backgroundColor: dot })]),
        text,
      ),
    ),
  )
}

function personRow(person: PersonStats, face: Face | undefined, share: number): Node {
  const name = face?.name ?? person.login
  const did: string[] = []
  if (person.merged > 0) did.push(count(person.merged, "PR"))
  if (person.commits > 0) did.push(count(person.commits, "commit"))
  if (person.additions + person.deletions > 0) {
    did.push(lineDelta(person.additions, person.deletions))
  }
  if (person.reviewed > 0) did.push(`${person.reviewed} reviewed`)
  if (person.closed > 0) did.push(`${person.closed} closed`)
  return h(
    "div",
    { alignItems: "center", gap: 22 },
    avatar(name, face?.avatar),
    h(
      "div",
      { flexDirection: "column", width: 220 },
      h("div", { fontSize: 30, fontWeight: 700 }, name),
      h("div", { fontSize: 22, color: PALETTE.faint }, person.login),
    ),
    // The bar is their share of the most active person's work; the text says what it was.
    h(
      "div",
      { flexDirection: "column", flex: 1, gap: 10 },
      h("div", {
        width: `${Math.max(3, Math.round(share * 100))}%`,
        height: 16,
        borderRadius: 999,
        backgroundImage: `linear-gradient(90deg, ${PALETTE.gold[0]}, ${PALETTE.gold[2]})`,
      }),
      h("div", { fontSize: 24, color: PALETTE.muted }, did.join(", ")),
    ),
  )
}

function avatar(name: string, src: string | undefined): Node {
  const size = 64
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
      fontSize: 30,
      fontWeight: 700,
    },
    (name[0] ?? "?").toUpperCase(),
  )
}

function highlightTile(kind: HighlightKind, pull: Merged): Node {
  let value = lineDelta(pull.additions, pull.deletions)
  if (kind === "talked") value = `${NUMBER.format(pull.comments)} comments`
  if (kind === "fastest") value = duration(pull.minutesToMerge)
  return h(
    "div",
    {
      flexDirection: "column",
      flex: 1,
      padding: "22px 24px",
      borderRadius: 24,
      backgroundColor: PALETTE.surface,
      border: `1px solid ${PALETTE.line}`,
    },
    h("div", { fontSize: 22, color: PALETTE.muted }, HIGHLIGHT_LABEL[kind]),
    h(
      "div",
      { fontSize: 30, fontWeight: 700, marginTop: 6, gap: 10 },
      h("span", { color: PALETTE.pink }, `#${pull.number}`),
      h("span", {}, value),
    ),
    h("div", { fontSize: 22, color: PALETTE.faint, marginTop: 4 }, repoName(pull.repo)),
  )
}
