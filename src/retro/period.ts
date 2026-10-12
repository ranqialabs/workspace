// The stretch of time a retro covers: a day or a week, in the team's time
// zone, as GitHub's search takes it.
import { addDays, localTime, offset } from "../time"

export type PeriodKind = "day" | "week"

export interface Period {
  kind: PeriodKind
  /** The first local day, `2026-10-12`. */
  first: string
  /** The local day after the last, exclusive. */
  next: string
  /** `2026-10-12T00:00:00-03:00..2026-10-13T00:00:00-03:00`, for a search qualifier. */
  range: string
  /** The same bounds as instants. */
  from: number
  to: number
}

/** The day, or the Monday-to-Sunday week, that `at` falls in. */
export function periodAt(kind: PeriodKind, at: number, timeZone: string): Period {
  const { date, weekday } = localTime(at, timeZone)
  // Monday starts the week; Sunday is its last day.
  const first = kind === "day" ? date : addDays(date, -((weekday + 6) % 7))
  const next = addDays(first, kind === "day" ? 1 : 7)
  const zone = offset(at, timeZone)
  const from = `${first}T00:00:00${zone}`
  const to = `${next}T00:00:00${zone}`
  return { kind, first, next, range: `${from}..${to}`, from: Date.parse(from), to: Date.parse(to) }
}
