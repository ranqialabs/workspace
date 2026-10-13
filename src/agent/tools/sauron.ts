// The agent's Sauron tools: metrics, logs, traces, alerts, dashboards, the
// Ada's database and CloudWatch, all through Grafana with a Viewer token. Like
// the GitHub tools they only read. Each answer is trimmed to what a model can
// reason about, and the queries hand back an Explore link so people can check.
import { tool } from "ai"
import { z } from "zod"

import {
  column,
  type Frame,
  fieldsOf,
  iso,
  type Range,
  range,
  rowsOf,
  type Sauron,
  type Series,
  seriesOf,
} from "../../sauron/client"

const MAX_SERIES = 25
const MAX_NAMES = 120
const MAX_VALUES = 15
const MAX_LINES = 100
const MAX_LINE_CHARS = 500
const MAX_ROWS = 200
const MAX_CELL_CHARS = 300
const MAX_SPANS = 80
const MAX_TRACES = 20

export const SAURON_INSTRUCTIONS = `\
Sauron (sauron.ranqia.io) is the team's Grafana. Through it you read production:
- Mimir, metrics (PromQL): OpenTelemetry metrics labeled by \`service_name\`
  (ai-core, dorothy, mary, ranqia, which is the Ada), like
  \`http_server_request_duration_seconds\` and \`celery_tasks_queued\`.
- Loki, logs (LogQL): streams labeled by \`service_name\`; each line carries
  its \`trace_id\` when it has one.
- Tempo, traces (TraceQL), from the same services.
- Aurora (SQL, read-only): the Ada's Postgres, for questions about the business
  (executions, citations, jobs). Its tables live in the \`ranqia\` schema, so
  write \`ranqia.prompt_executions\`.
- CloudWatch: AWS/RDS, AWS/ECS, AWS/ApplicationELB, AWS/ElastiCache.

Start from what the team already built: \`sauron_dashboards\` and
\`sauron_dashboard\` give the panels and the exact queries behind them, and
\`sauron_alerts\` says what is firing. Look a metric or label up
(\`metric_names\`, \`metric_labels\`, \`log_labels\`, \`sql_tables\`) before
writing a query on a guess.

Pick the time window from the question; it defaults to the last hour. A log line
or a slow request leads to its trace with \`get_trace\`. In SQL, aggregate:
what you read goes into the chat, so count and group rather than list
customers' data, and never paste personal data back. Quote the numbers you saw
and link the \`explore\` URL a query returns so people can open it.`

const fromArg = z.string().default("now-1h").describe('Start: "now-6h", "now-7d" or an ISO date')
const toArg = z.string().default("now").describe('End: "now" or an ISO date')

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function more(total: number, shown: number, noun: string): string | undefined {
  return total > shown
    ? `Showing ${shown} of ${total} ${noun}; narrow the query for the rest.`
    : undefined
}

function seriesAnswer(all: Series[], explore: string) {
  const series = all.filter((one) => one.last !== null || one.max !== null)
  return {
    series: series.slice(0, MAX_SERIES),
    note:
      series.length === 0
        ? "No data in this window. Check the metric and label names before saying it is zero."
        : more(series.length, MAX_SERIES, "series"),
    explore,
  }
}

const Labels = z.record(z.string(), z.string())

// Labels every OpenTelemetry line carries that never tell lines apart.
const NOISE =
  /^(aws_|cloud_|telemetry_|otel|observed_timestamp$|flags$|service_instance_id$|severity_number$|span_id$|deployment_environment$|labelTypes$)/

function logsAnswer(frames: Frame[], explore: string) {
  const lines = frames.flatMap((frame) => {
    const fields = fieldsOf(frame)
    const at = (name: string) => fields.findIndex((field) => field.name === name)
    const [labels, time, line] = [at("labels"), at("Time"), at("Line")]
    return column(frame, line).map((text, index) => ({
      time: iso(column(frame, time)[index]),
      line: cut(String(text), MAX_LINE_CHARS),
      labels: Object.fromEntries(
        Object.entries(Labels.catch({}).parse(column(frame, labels)[index])).filter(
          ([key]) => !NOISE.test(key),
        ),
      ),
    }))
  })
  // Labels shared by every line are said once.
  const common: Record<string, string> = { ...lines[0]?.labels }
  for (const { labels } of lines) {
    for (const key of Object.keys(common)) if (labels[key] !== common[key]) delete common[key]
  }
  return {
    common,
    lines: lines.slice(0, MAX_LINES).map(({ time, line, labels }) => {
      const own = Object.entries(labels).filter(([key]) => !(key in common))
      return own.length === 0 ? { time, line } : { time, line, labels: Object.fromEntries(own) }
    }),
    note: lines.length === 0 ? "No lines matched in this window." : undefined,
    explore,
  }
}

function isLogs(frames: Frame[]): boolean {
  return frames.some((frame) => fieldsOf(frame).some((field) => field.name === "Line"))
}

/** Only a single SELECT (or WITH) gets through, and it is wrapped in a LIMIT. */
export function boundedSql(sql: string, limit: number): string {
  const body = sql.trim().replace(/;\s*$/, "")
  if (!/^(select|with)\b/i.test(body)) throw new Error("Only SELECT (or WITH ... SELECT) queries.")
  if (body.includes(";")) throw new Error("One statement at a time, without semicolons.")
  return `SELECT * FROM (\n${body}\n) AS bob LIMIT ${limit + 1}`
}

interface Panel {
  title?: string
  type?: string
  description?: string
  datasource?: unknown
  targets?: Record<string, unknown>[]
  panels?: Panel[]
}

const PanelSchema: z.ZodType<Panel> = z.lazy(() =>
  z.object({
    title: z.string().optional(),
    type: z.string().optional(),
    description: z.string().optional(),
    datasource: z.unknown().optional(),
    targets: z.array(z.record(z.string(), z.unknown())).optional(),
    panels: z.array(PanelSchema).optional(),
  }),
)

const DashboardSchema = z.object({
  dashboard: z.object({
    title: z.string(),
    description: z.string().optional(),
    templating: z
      .object({ list: z.array(z.object({ name: z.string(), query: z.unknown() })).optional() })
      .optional(),
    panels: z.array(PanelSchema).optional(),
  }),
  meta: z.object({ url: z.string().optional() }).optional(),
})

// What a panel's query says, without the editor's state.
const QUERY_KEYS = [
  "expr",
  "rawSql",
  "query",
  "expression",
  "queryMode",
  "namespace",
  "metricName",
  "statistic",
  "dimensions",
  "legendFormat",
]

function panelsOf(panels: Panel[]): Panel[] {
  return panels.flatMap((panel) => (panel.type === "row" ? panelsOf(panel.panels ?? []) : [panel]))
}

function uidOf(datasource: unknown): string | undefined {
  if (typeof datasource === "string") return datasource
  if (typeof datasource === "object" && datasource !== null && "uid" in datasource) {
    return typeof datasource.uid === "string" ? datasource.uid : undefined
  }
  return undefined
}

const RulesSchema = z.object({
  data: z
    .object({
      groups: z.array(
        z.object({
          name: z.string(),
          rules: z
            .array(
              z.object({
                name: z.string(),
                state: z.string().optional(),
                health: z.string().optional(),
                query: z.string().optional(),
                lastError: z.string().optional(),
                alerts: z
                  .array(
                    z.object({
                      labels: Labels.optional(),
                      state: z.string().optional(),
                      activeAt: z.string().optional(),
                      value: z.string().optional(),
                    }),
                  )
                  .nullish(),
              }),
            )
            .optional(),
        }),
      ),
    })
    .optional(),
})

const OtlpValue = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
})
type OtlpValue = z.infer<typeof OtlpValue>
const OtlpAttributes = z.array(z.object({ key: z.string(), value: OtlpValue.optional() }))
const OtlpSpan = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: OtlpAttributes.optional(),
  status: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
})
type OtlpSpan = z.infer<typeof OtlpSpan>
const OtlpTrace = z.object({
  batches: z
    .array(
      z.object({
        resource: z.object({ attributes: OtlpAttributes.optional() }).optional(),
        scopeSpans: z.array(z.object({ spans: z.array(OtlpSpan).optional() })).optional(),
      }),
    )
    .optional(),
})
type OtlpTrace = z.infer<typeof OtlpTrace>

const Names = z.object({ data: z.array(z.string()).nullish() })

const TempoSearch = z.object({
  traces: z
    .array(
      z.object({
        traceID: z.string(),
        rootServiceName: z.string().optional(),
        rootTraceName: z.string().optional(),
        startTimeUnixNano: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    )
    .optional(),
})

const DashboardHits = z.array(
  z.object({
    uid: z.string(),
    title: z.string(),
    folderTitle: z.string().optional(),
    url: z.string(),
  }),
)

/** Microseconds as milliseconds, from OTLP's nanosecond strings. */
function nanos(text: string): number {
  return Number(BigInt(text) / 1000n) / 1000
}

function quote(text: string | undefined): string {
  return `'${(text ?? "").replaceAll("'", "''")}'`
}

function valueOf(value: OtlpValue | undefined): string {
  if (value === undefined) return ""
  return cut(
    String(value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? ""),
    MAX_CELL_CHARS,
  )
}

/** The spans of a trace, in start order, with their depth in the tree. */
export function spansOf(trace: OtlpTrace) {
  const spans = (trace.batches ?? []).flatMap((batch) => {
    const service =
      batch.resource?.attributes?.find((attribute) => attribute.key === "service.name")?.value
        ?.stringValue ?? "?"
    return (batch.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({ service, span })),
    )
  })
  const byId = new Map(spans.map((entry) => [entry.span.spanId, entry.span]))
  const depth = (span: OtlpSpan): number => {
    let level = 0
    let parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId)
    while (parent !== undefined && level < 50) {
      level += 1
      parent = parent.parentSpanId === undefined ? undefined : byId.get(parent.parentSpanId)
    }
    return level
  }
  const start = Math.min(...spans.map(({ span }) => nanos(span.startTimeUnixNano)))
  return spans
    .toSorted((a, b) => nanos(a.span.startTimeUnixNano) - nanos(b.span.startTimeUnixNano))
    .map(({ service, span }) => {
      const failed = span.status?.code === "STATUS_CODE_ERROR"
      return {
        depth: depth(span),
        service,
        name: span.name,
        atMs: Number((nanos(span.startTimeUnixNano) - start).toFixed(1)),
        durationMs: Number(
          (nanos(span.endTimeUnixNano) - nanos(span.startTimeUnixNano)).toFixed(2),
        ),
        ...(failed ? { error: span.status?.message ?? "error" } : {}),
        attributes: Object.fromEntries(
          (span.attributes ?? []).slice(0, 12).map(({ key, value }) => [key, valueOf(value)]),
        ),
      }
    })
}

export function sauronTools(sauron: Sauron) {
  const mimir = "mimir"
  const loki = "loki"

  async function promql(query: string, window: Range, instantOnly: boolean) {
    const request = instantOnly
      ? { expr: query, instant: true, range: false }
      : { expr: query, range: true, maxDataPoints: 120 }
    const frames = await sauron.query(mimir, request, window)
    return seriesAnswer(seriesOf(frames), sauron.explore(mimir, { expr: query }, window))
  }

  async function sql(query: string, limit: number) {
    const window = range("now-1h", "now")
    const rawSql = boundedSql(query, limit)
    const frames = await sauron.query("aurora", { rawSql, format: "table", rawQuery: true }, window)
    const frame = frames[0]
    const rows = frame === undefined ? [] : rowsOf(frame, limit + 1)
    return {
      columns: frame === undefined ? [] : fieldsOf(frame).map((field) => field.name),
      rows: rows
        .slice(0, limit)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === "string" ? cut(value, MAX_CELL_CHARS) : value,
            ]),
          ),
        ),
      note: rows.length > limit ? `Stopped at ${limit} rows; aggregate or filter.` : undefined,
      explore: sauron.explore("aurora", { rawSql: query, format: "table", rawQuery: true }, window),
    }
  }

  return {
    sauron_dashboards: tool({
      description: "The dashboards in Sauron, optionally matching a title.",
      inputSchema: z.object({ search: z.string().default("") }),
      execute: async ({ search }) => {
        const found = await sauron.get("/api/search", DashboardHits, {
          type: "dash-db",
          query: search,
        })
        return found.map(({ uid, title, folderTitle, url }) => ({
          uid,
          title,
          folder: folderTitle,
          url: `${sauron.url}${url}`,
        }))
      },
    }),

    sauron_dashboard: tool({
      description:
        "A dashboard's panels and the exact query behind each, to reuse with the query tools.",
      inputSchema: z.object({ uid: z.string() }),
      execute: async ({ uid }) => {
        const { dashboard, meta } = await sauron.get(
          `/api/dashboards/uid/${encodeURIComponent(uid)}`,
          DashboardSchema,
        )
        return {
          title: dashboard.title,
          description: dashboard.description,
          url: meta?.url === undefined ? undefined : `${sauron.url}${meta.url}`,
          variables: (dashboard.templating?.list ?? []).map(({ name, query }) => ({
            name,
            query: typeof query === "string" ? query : JSON.stringify(query),
          })),
          panels: panelsOf(dashboard.panels ?? []).map((panel) => ({
            title: panel.title,
            description: panel.description,
            queries: (panel.targets ?? []).map((target) => ({
              datasource: uidOf(target.datasource) ?? uidOf(panel.datasource),
              ...Object.fromEntries(
                QUERY_KEYS.flatMap((key) =>
                  target[key] === undefined || target[key] === "" ? [] : [[key, target[key]]],
                ),
              ),
            })),
          })),
        }
      },
    }),

    sauron_alerts: tool({
      description:
        "Sauron's alert rules with their state, firing ones first, and the instances that fire.",
      inputSchema: z.object({}),
      execute: async () => {
        const rules = await sauron.get("/api/prometheus/grafana/api/v1/rules", RulesSchema)
        const order: Record<string, number> = { firing: 0, pending: 1 }
        return (rules.data?.groups ?? [])
          .flatMap((group) =>
            (group.rules ?? []).map((rule) => ({
              name: rule.name,
              group: group.name,
              state: rule.state,
              health: rule.health,
              lastError: rule.lastError === "" ? undefined : rule.lastError,
              query: rule.query,
              firing: (rule.alerts ?? [])
                .filter((alert) => alert.state?.toLowerCase().startsWith("alerting"))
                .slice(0, 10)
                .map((alert) => ({
                  labels: Object.fromEntries(
                    Object.entries(alert.labels ?? {}).filter(([key]) => !key.startsWith("__")),
                  ),
                  since: alert.activeAt,
                  value: alert.value,
                })),
            })),
          )
          .toSorted((a, b) => (order[a.state ?? ""] ?? 2) - (order[b.state ?? ""] ?? 2))
      },
    }),

    metric_names: tool({
      description: "Metric names in Mimir that contain a piece of text.",
      inputSchema: z.object({
        search: z.string().describe("Part of the name, like http or celery"),
      }),
      execute: async ({ search }) => {
        const { data } = await sauron.get(
          `/api/datasources/proxy/uid/${mimir}/api/v1/label/__name__/values`,
          Names,
        )
        const found = (data ?? []).filter((name) =>
          name.toLowerCase().includes(search.toLowerCase()),
        )
        return { names: found.slice(0, MAX_NAMES), note: more(found.length, MAX_NAMES, "names") }
      },
    }),

    metric_labels: tool({
      description: "The labels of a metric in the last day, with the values each takes.",
      inputSchema: z.object({ metric: z.string() }),
      execute: async ({ metric }) => {
        const window = range("now-1d", "now")
        const { data } = await sauron.get(
          `/api/datasources/proxy/uid/${mimir}/api/v1/series`,
          z.object({ data: z.array(Labels) }),
          {
            "match[]": metric,
            start: String(window.from / 1000),
            end: String(window.to / 1000),
            limit: "500",
          },
        )
        const values = new Map<string, Set<string>>()
        for (const series of data) {
          for (const [label, value] of Object.entries(series)) {
            if (label === "__name__") continue
            const seen = values.get(label) ?? new Set<string>()
            seen.add(value)
            values.set(label, seen)
          }
        }
        return {
          series: data.length,
          labels: Object.fromEntries(
            [...values].map(([label, seen]) => [
              label,
              seen.size > MAX_VALUES
                ? { count: seen.size, some: [...seen].slice(0, MAX_VALUES) }
                : [...seen],
            ]),
          ),
        }
      },
    }),

    query_metrics: tool({
      description:
        "Run PromQL on Mimir. Each series comes back with last/min/max/avg and a few points; `instant` gives one value per series.",
      inputSchema: z.object({
        query: z.string().describe("PromQL"),
        from: fromArg,
        to: toArg,
        instant: z.boolean().default(false),
      }),
      execute: ({ query, from, to, instant }) => promql(query, range(from, to), instant),
    }),

    log_labels: tool({
      description: "Loki's label names, or the values of one label, to build a LogQL selector.",
      inputSchema: z.object({ label: z.string().optional() }),
      execute: async ({ label }) => {
        const path =
          label === undefined
            ? `/api/datasources/proxy/uid/${loki}/loki/api/v1/labels`
            : `/api/datasources/proxy/uid/${loki}/loki/api/v1/label/${encodeURIComponent(label)}/values`
        const { data } = await sauron.get(path, Names)
        return data ?? []
      },
    }),

    query_logs: tool({
      description:
        'Run LogQL on Loki. A selector like {service_name="mary"} |= "error" returns lines, newest first; a metric query like sum by (service_name) (count_over_time({...}[5m])) returns series.',
      inputSchema: z.object({
        query: z.string().describe("LogQL"),
        from: fromArg,
        to: toArg,
        limit: z.number().int().min(1).max(MAX_LINES).default(50),
      }),
      execute: async ({ query, from, to, limit }) => {
        const window = range(from, to)
        const request = { expr: query, queryType: "range", maxLines: limit, direction: "backward" }
        const frames = await sauron.query(loki, request, window)
        const explore = sauron.explore(loki, { expr: query, queryType: "range" }, window)
        return isLogs(frames)
          ? logsAnswer(frames, explore)
          : seriesAnswer(seriesOf(frames), explore)
      },
    }),

    find_traces: tool({
      description:
        'Search Tempo with TraceQL, like { resource.service.name = "mary" && status = error } or { duration > 2s }.',
      inputSchema: z.object({
        query: z.string().describe("TraceQL"),
        from: fromArg,
        to: toArg,
        limit: z.number().int().min(1).max(MAX_TRACES).default(10),
      }),
      execute: async ({ query, from, to, limit }) => {
        const window = range(from, to)
        const { traces } = await sauron.get(
          `/api/datasources/proxy/uid/tempo/api/search`,
          TempoSearch,
          {
            q: query,
            start: String(Math.floor(window.from / 1000)),
            end: String(Math.ceil(window.to / 1000)),
            limit: String(limit),
          },
        )
        return {
          traces: (traces ?? []).map((trace) => ({
            id: trace.traceID,
            service: trace.rootServiceName,
            name: trace.rootTraceName,
            start:
              trace.startTimeUnixNano === undefined
                ? undefined
                : iso(Number(BigInt(trace.startTimeUnixNano) / 1_000_000n)),
            durationMs: trace.durationMs ?? 0,
          })),
          explore: sauron.explore("tempo", { queryType: "traceql", query }, window),
        }
      },
    }),

    get_trace: tool({
      description: "A trace's spans in start order, with depth, timing, errors and attributes.",
      inputSchema: z.object({ id: z.string().describe("The trace id, in hex") }),
      execute: async ({ id }) => {
        const trace = await sauron.get(
          `/api/datasources/proxy/uid/tempo/api/traces/${encodeURIComponent(id.trim())}`,
          OtlpTrace,
        )
        const spans = spansOf(trace)
        return {
          spans: spans.slice(0, MAX_SPANS),
          note: more(spans.length, MAX_SPANS, "spans"),
          url: `${sauron.url}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(
            JSON.stringify({
              a: {
                datasource: "tempo",
                queries: [
                  { refId: "A", datasource: { uid: "tempo" }, queryType: "traceql", query: id },
                ],
              },
            }),
          )}`,
        }
      },
    }),

    sql_tables: tool({
      description:
        "The tables of the Ada's database with their approximate row counts, or the columns of one table.",
      inputSchema: z.object({
        table: z
          .string()
          .optional()
          .describe('"schema.table", or just "table" to look in every schema'),
      }),
      execute: async ({ table }) => {
        if (table === undefined) {
          const listed = await sql(
            `SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS approx_rows
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p', 'v', 'm')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE '%_tests'
             ORDER BY 1, 2`,
            500,
          )
          // One line per schema reads far shorter than a row per table.
          const schemas: Record<string, string[]> = {}
          for (const row of listed.rows) {
            const rows = Number(row.approx_rows)
            const name = `${String(row.name)}${rows > 0 ? ` (~${rows})` : ""}`
            ;(schemas[String(row.schema)] ??= []).push(name)
          }
          return schemas
        }
        const [schema, name] = table.includes(".") ? table.split(".", 2) : [undefined, table]
        return sql(
          `SELECT table_schema, column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_name = ${quote(name)}${schema === undefined ? "" : ` AND table_schema = ${quote(schema)}`}
           ORDER BY table_schema, ordinal_position`,
          MAX_ROWS,
        )
      },
    }),

    query_sql: tool({
      description:
        "Run one read-only SELECT on the Ada's Postgres (Aurora). Grafana macros like $__timeFilter(created_at) work.",
      inputSchema: z.object({
        query: z.string().describe("SQL"),
        limit: z.number().int().min(1).max(MAX_ROWS).default(50),
      }),
      execute: ({ query, limit }) => sql(query, limit),
    }),

    query_cloudwatch: tool({
      description:
        "A CloudWatch metric over time, one series per resource unless dimensions pin one.",
      inputSchema: z.object({
        namespace: z.string().describe("AWS/RDS, AWS/ECS, AWS/ApplicationELB, AWS/ElastiCache…"),
        metric: z.string().describe("CPUUtilization, DatabaseConnections, TargetResponseTime…"),
        dimensions: z
          .record(z.string(), z.string())
          .default({})
          .describe('Like {"ServiceName": "dorothy-api"}'),
        statistic: z.string().default("Average").describe("Average, Maximum, Sum, p95…"),
        period: z.number().int().min(60).default(300).describe("Seconds"),
        from: fromArg,
        to: toArg,
      }),
      execute: async ({ namespace, metric, dimensions, statistic, period, from, to }) => {
        const window = range(from, to)
        const request = {
          queryMode: "Metrics",
          metricQueryType: 0,
          metricEditorMode: 0,
          region: "default",
          namespace,
          metricName: metric,
          dimensions: Object.fromEntries(
            Object.entries(dimensions).map(([key, value]) => [key, [value]]),
          ),
          statistic,
          period: String(period),
          matchExact: false,
        }
        const frames = await sauron.query("cloudwatch", request, window)
        return seriesAnswer(seriesOf(frames), sauron.explore("cloudwatch", request, window))
      },
    }),
  }
}
