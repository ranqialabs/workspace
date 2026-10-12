// The team's clock. Workers run in UTC; reminders and retros follow the
// team's own days and working hours.

export interface LocalTime {
  /** 0 is Sunday. */
  weekday: number
  hour: number
  minute: number
  /** `2026-10-12`, the team's calendar day. */
  date: string
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function localTime(at: number, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? ""
  return {
    weekday: WEEKDAYS.indexOf(part("weekday")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    date: `${part("year")}-${part("month")}-${part("day")}`,
  }
}

/** Monday to Friday, 9:00 to 18:00. */
export function workingHours(at: number, timeZone: string): boolean {
  const { weekday, hour } = localTime(at, timeZone)
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 18
}

/** `26 hours`, `3 days`: how long, rounded down, for a reminder. */
export function waited(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 48) return `${hours} hours`
  return `${Math.floor(hours / 24)} days`
}
