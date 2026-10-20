// Sauron is the team's Grafana (sauron.ranqia.io): Mimir for metrics, Loki for
// logs, Tempo for traces, CloudWatch and the Ada's Aurora behind it. bob talks
// to Grafana's HTTP API with a Viewer service account token, so whatever the
// model asks for, it can read and never change anything.
//
// Grafana answers queries as data frames: columns of values, each with a name,
// a type and sometimes labels. The helpers here turn them into small rows a
// model can read without spending its context on them.

import { z } from "zod"

export const SAURON_URL = "https://sauron.ranqia.io"
// Grafana gives up on a datasource after 30 s; past that a query is not coming back.
const TIMEOUT_MS = 30_000

const FieldSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  labels: z.record(z.string(), z.string()).nullish(),
})
export type Field = z.infer<typeof FieldSchema>

const FrameSchema = z.object({
  schema: z.object({ fields: z.array(FieldSchema) }).optional(),
  data: z.object({ values: z.array(z.array(z.unknown())) }).optional(),
})
export type Frame = z.infer<typeof FrameSchema>

const QueryResponse = z.object({
  results: z
    .record(
      z.string(),
      z.object({ error: z.string().optional(), frames: z.array(FrameSchema).optional() }),
    )
    .optional(),
  message: z.string().optional(),
  error: z.string().optional(),
})

const UNITS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

/** A moment as Grafana reads it: milliseconds since the epoch, as text. */
export function instant(when: string, now: number = Date.now()): number {
  const text = when.trim()
  if (text === "now") return now
  const relative = /^now-(\d+)(s|m|h|d|w)$/.exec(text)
  if (relative !== null) {
    const unit = Object.entries(UNITS).find(([name]) => name === relative[2])?.[1] ?? 1
    return now - Number(relative[1]) * unit * 1000
  }
  if (/^\d{12,}$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new Error(`"${when}" is not a time. Use "now", "now-6h", "now-7d" or an ISO date.`)
  }
  return parsed
}

export interface Range {
  from: number
  to: number
}

export function range(from: string, to: string, now: number = Date.now()): Range {
  const window = { from: instant(from, now), to: instant(to, now) }
  if (window.from >= window.to) throw new Error(`"${from}" is not before "${to}".`)
  return window
}

export class Sauron {
  constructor(
    readonly url: string,
    private readonly token: string,
    // Called as `this.fetcher(...)`, so it must not be the global itself:
    // workerd refuses a native `fetch` whose `this` is not the global.
    private readonly fetcher: typeof fetch = (request, init) => fetch(request, init),
  ) {}

  async get<S extends z.ZodType>(
    path: string,
    schema: S,
    params: Record<string, string | string[]> = {},
  ): Promise<z.infer<S>> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      for (const one of Array.isArray(value) ? value : [value]) search.append(key, one)
    }
    const query = search.size > 0 ? `?${search.toString()}` : ""
    return schema.parse(await this.send(`${path}${query}`, { method: "GET" }))
  }

  /** One query against one datasource; the frames, or the datasource's own error. */
  async query(datasource: string, query: object, window: Range): Promise<Frame[]> {
    const sent = await this.send("/api/ds/query", {
      method: "POST",
      body: JSON.stringify({
        from: String(window.from),
        to: String(window.to),
        queries: [{ refId: "A", datasource: { uid: datasource }, ...query }],
      }),
    })
    const result = QueryResponse.parse(sent).results?.A
    if (result?.error !== undefined && result.error !== "") {
      throw new Error(`${datasource} said: ${result.error.slice(0, 500)}`)
    }
    return result?.frames ?? []
  }

  /** A link that opens the query in Grafana's Explore, for people to check bob. */
  explore(datasource: string, query: object, window: Range): string {
    const panes = {
      a: {
        datasource,
        queries: [{ refId: "A", datasource: { uid: datasource }, ...query }],
        range: { from: String(window.from), to: String(window.to) },
      },
    }
    return `${this.url}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`${this.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      // A query that fails inside a datasource still comes back as JSON with its reason.
      const reason = reasonOf(text)
      throw new Error(`Sauron answered ${response.status}${reason === "" ? "" : `: ${reason}`}`)
    }
    const body: unknown = JSON.parse(text)
    return body
  }
}

function reasonOf(text: string): string {
  try {
    const parsed = QueryResponse.safeParse(JSON.parse(text))
    if (!parsed.success) return text.slice(0, 200)
    const body = parsed.data
    const inner = Object.values(body.results ?? {}).find((result) => result.error)?.error
    return (inner ?? body.message ?? body.error ?? "").slice(0, 500)
  } catch {
    return text.slice(0, 200)
  }
}

// --- frames -----------------------------------------------------------------

/** Values of a column, or an empty list for one that is not there. */
export function column(frame: Frame, index: number): unknown[] {
  return frame.data?.values[index] ?? []
}

export function fieldsOf(frame: Frame): Field[] {
  return frame.schema?.fields ?? []
}

export function iso(ms: unknown): string {
  return typeof ms === "number" ? new Date(ms).toISOString().replace(".000Z", "Z") : String(ms)
}

/** Four significant digits are plenty to talk about. */
export function round(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Number(value.toPrecision(4))
}

export interface Series {
  labels: Record<string, string>
  last: number | null
  min: number | null
  max: number | null
  avg: number | null
  /** At most POINTS, evenly picked, as [ISO time, value]. */
  points: [string, number | null][]
}

const POINTS = 16

/** Each numeric column of each frame against its time column. */
export function seriesOf(frames: Frame[]): Series[] {
  return frames.flatMap((frame) => {
    const fields = fieldsOf(frame)
    const timeAt = fields.findIndex((field) => field.type === "time")
    const times = timeAt === -1 ? [] : column(frame, timeAt)
    return fields.flatMap((field, index) => {
      if (field.type !== "number") return []
      const values = column(frame, index)
      const numbers = values.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      )
      const step = Math.max(1, Math.ceil(values.length / POINTS))
      const points: [string, number | null][] = []
      for (let at = values.length - 1; at >= 0; at -= step) {
        points.unshift([iso(times[at]), round(values[at])])
      }
      return [
        {
          labels: field.labels ?? (field.name === "Value" ? {} : { name: field.name }),
          last: round(numbers.at(-1)),
          min: numbers.length === 0 ? null : round(Math.min(...numbers)),
          max: numbers.length === 0 ? null : round(Math.max(...numbers)),
          avg:
            numbers.length === 0
              ? null
              : round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length),
          points: timeAt === -1 ? [] : points,
        },
      ]
    })
  })
}

/** A frame as rows of `{column: value}`, times as ISO. */
export function rowsOf(frame: Frame, limit: number): Record<string, unknown>[] {
  const fields = fieldsOf(frame)
  const length = column(frame, 0).length
  const rows: Record<string, unknown>[] = []
  for (let at = 0; at < Math.min(length, limit); at += 1) {
    const row: Record<string, unknown> = {}
    fields.forEach((field, index) => {
      const value = column(frame, index)[at]
      row[field.name] = field.type === "time" ? iso(value) : value
    })
    rows.push(row)
  }
  return rows
}
