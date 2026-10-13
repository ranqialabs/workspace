import { describe, expect, test } from "bun:test"

import { boundedSql, sauronTools, spansOf } from "../../src/agent/tools/sauron"
import { instant, range, Sauron } from "../../src/sauron/client"

const NOW = Date.parse("2026-10-13T12:00:00Z")
const WINDOW = { from: "now-1h", to: "now", instant: false }

function labels(id: string) {
  return {
    service_name: "mary",
    aws_ecs_task_arn: "arn:…",
    telemetry_sdk_name: "opentelemetry",
    trace_id: id,
  }
}

function span(id: string, parent: string | undefined, start: number, end: number) {
  return {
    spanId: id,
    parentSpanId: parent,
    name: `span ${id}`,
    startTimeUnixNano: String(BigInt(start) * 1_000_000n),
    endTimeUnixNano: String(BigInt(end) * 1_000_000n),
    attributes: [{ key: "http.route", value: { stringValue: "/v1/x" } }],
  }
}

interface Sent {
  url: string
  method: string
  body: unknown
  auth: string | null
}

function fakeSauron(answer: (sent: Sent) => [number, unknown]): { sauron: Sauron; sent: Sent[] } {
  const sent: Sent[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const one: Sent = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("authorization"),
    }
    sent.push(one)
    const [status, body] = answer(one)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { sauron: new Sauron("https://sauron.test", "glsa_token", fetcher), sent }
}

async function call(
  sauron: Sauron,
  name: keyof ReturnType<typeof sauronTools>,
  input: object,
): Promise<unknown> {
  const chosen = sauronTools(sauron)[name]
  return chosen.execute?.(input as never, { toolCallId: "t", messages: [], context: {} })
}

describe("time", () => {
  test("relative, ISO and epoch all become milliseconds", () => {
    expect(instant("now", NOW)).toBe(NOW)
    expect(instant("now-6h", NOW)).toBe(NOW - 6 * 3_600_000)
    expect(instant("now-7d", NOW)).toBe(NOW - 7 * 86_400_000)
    expect(instant("2026-10-12T00:00:00Z", NOW)).toBe(Date.parse("2026-10-12T00:00:00Z"))
    expect(instant(String(NOW), NOW)).toBe(NOW)
  })

  test("nonsense and a backwards window are refused with the way out", () => {
    expect(() => instant("yesterday-ish", NOW)).toThrow('Use "now", "now-6h"')
    expect(() => range("now", "now-1h", NOW)).toThrow("is not before")
  })
})

describe("SQL", () => {
  test("one SELECT goes through wrapped in a limit", () => {
    expect(boundedSql("select 1;", 50)).toBe("SELECT * FROM (\nselect 1\n) AS bob LIMIT 51")
    expect(boundedSql("WITH a AS (select 1) select * from a", 10)).toContain("LIMIT 11")
  })

  test("anything else is refused before it leaves", () => {
    expect(() => boundedSql("delete from users", 10)).toThrow("Only SELECT")
    expect(() => boundedSql("select 1; drop table users", 10)).toThrow("One statement")
  })

  test("query_sql stops at the limit and says so", async () => {
    const { sauron, sent } = fakeSauron(() => [
      200,
      {
        results: {
          A: {
            frames: [
              {
                schema: { fields: [{ name: "n", type: "number" }] },
                data: { values: [[1, 2, 3]] },
              },
            ],
          },
        },
      },
    ])
    const answer = await call(sauron, "query_sql", { query: "select n from t", limit: 2 })
    expect(answer).toMatchObject({ columns: ["n"], rows: [{ n: 1 }, { n: 2 }] })
    expect(answer).toHaveProperty("note", "Stopped at 2 rows; aggregate or filter.")
    expect(sent[0]?.body).toMatchObject({
      queries: [{ datasource: { uid: "aurora" }, rawSql: expect.stringContaining("LIMIT 3") }],
    })
  })
})

describe("metrics", () => {
  test("a series comes back summed up, with a link to Explore", async () => {
    const times = Array.from({ length: 40 }, (_, index) => NOW - (40 - index) * 60_000)
    const values = times.map((_, index) => index)
    const { sauron, sent } = fakeSauron(() => [
      200,
      {
        results: {
          A: {
            frames: [
              {
                schema: {
                  fields: [
                    { name: "Time", type: "time" },
                    { name: "Value", type: "number", labels: { service_name: "mary" } },
                  ],
                },
                data: { values: [times, values] },
              },
            ],
          },
        },
      },
    ])
    const answer = await call(sauron, "query_metrics", {
      query: "up",
      from: "now-1h",
      to: "now",
      instant: false,
    })
    expect(sent[0]?.auth).toBe("Bearer glsa_token")
    expect(sent[0]?.url).toBe("https://sauron.test/api/ds/query")
    expect(answer).toMatchObject({
      series: [{ labels: { service_name: "mary" }, last: 39, min: 0, max: 39, avg: 19.5 }],
      explore: expect.stringMatching(/^https:\/\/sauron\.test\/explore\?/),
    })
    const [series] = (answer as { series: { points: unknown[] }[] }).series
    expect(series?.points.length).toBeLessThanOrEqual(16)
    expect(series?.points.at(-1)).toEqual(["2026-10-13T11:59:00Z", 39])
  })

  test("no data says to check the names instead of reading zero", async () => {
    const { sauron } = fakeSauron(() => [200, { results: { A: { frames: [] } } }])
    expect(await call(sauron, "query_metrics", { query: "nope", ...WINDOW })).toMatchObject({
      series: [],
      note: expect.stringContaining("Check the metric"),
    })
  })

  test("a datasource's error reaches the model in its own words", async () => {
    const { sauron } = fakeSauron(() => [
      400,
      { results: { A: { error: "parse error at char 3", status: 400 } } },
    ])
    expect(call(sauron, "query_metrics", { query: "up{", ...WINDOW })).rejects.toThrow(
      "Sauron answered 400: parse error at char 3",
    )
  })
})

describe("logs", () => {
  test("labels shared by every line are said once, and the noisy ones never", async () => {
    const { sauron } = fakeSauron(() => [
      200,
      {
        results: {
          A: {
            frames: [
              {
                schema: {
                  fields: [
                    { name: "labels", type: "other" },
                    { name: "Time", type: "time" },
                    { name: "Line", type: "string" },
                  ],
                },
                data: {
                  values: [
                    [labels("a1"), labels("b2")],
                    [NOW, NOW - 1000],
                    ["boom", "x".repeat(900)],
                  ],
                },
              },
            ],
          },
        },
      },
    ])
    const answer = await call(sauron, "query_logs", {
      query: '{service_name="mary"}',
      from: "now-1h",
      to: "now",
      limit: 50,
    })
    expect(answer).toMatchObject({
      common: { service_name: "mary" },
      lines: [
        { time: "2026-10-13T12:00:00Z", line: "boom", labels: { trace_id: "a1" } },
        { labels: { trace_id: "b2" } },
      ],
    })
    const second = (answer as { lines: { line: string }[] }).lines[1]
    expect(second?.line.length).toBe(501)
  })
})

describe("traces", () => {
  test("spans come in start order with their depth and errors", () => {
    const spans = spansOf({
      batches: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "mary" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  ...span("c", "b", NOW + 5, NOW + 9),
                  status: { code: "STATUS_CODE_ERROR", message: "boom" },
                },
                span("a", undefined, NOW, NOW + 20),
                span("b", "a", NOW + 2, NOW + 10),
              ],
            },
          ],
        },
      ],
    })
    expect(
      spans.map(({ name, depth, atMs, durationMs }) => [name, depth, atMs, durationMs]),
    ).toEqual([
      ["span a", 0, 0, 20],
      ["span b", 1, 2, 8],
      ["span c", 2, 5, 4],
    ])
    expect(spans[2]).toMatchObject({
      service: "mary",
      error: "boom",
      attributes: { "http.route": "/v1/x" },
    })
  })
})

describe("dashboards and alerts", () => {
  test("a dashboard reads as its panels and their queries, rows flattened", async () => {
    const { sauron } = fakeSauron(() => [
      200,
      {
        dashboard: {
          title: "Ops",
          panels: [
            {
              type: "row",
              title: "Row",
              panels: [
                {
                  title: "Queued",
                  type: "timeseries",
                  datasource: { uid: "mimir" },
                  targets: [
                    { refId: "A", expr: "celery_tasks_queued", hide: false, editorMode: "code" },
                  ],
                },
              ],
            },
          ],
        },
        meta: { url: "/d/ops/ops" },
      },
    ])
    expect(await call(sauron, "sauron_dashboard", { uid: "ops" })).toMatchObject({
      title: "Ops",
      url: "https://sauron.test/d/ops/ops",
      panels: [
        { title: "Queued", queries: [{ datasource: "mimir", expr: "celery_tasks_queued" }] },
      ],
    })
  })

  test("firing rules come first, with their instances", async () => {
    const { sauron } = fakeSauron(() => [
      200,
      {
        data: {
          groups: [
            {
              name: "ops",
              rules: [
                { name: "Quiet", state: "inactive", health: "ok", alerts: null },
                {
                  name: "Loud",
                  state: "firing",
                  health: "ok",
                  alerts: [
                    {
                      labels: { queue: "deploy", __alert_rule_uid__: "x" },
                      state: "Alerting",
                      activeAt: "2026-10-13T10:00:00Z",
                      value: "12",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ])
    expect(await call(sauron, "sauron_alerts", {})).toMatchObject([
      { name: "Loud", firing: [{ labels: { queue: "deploy" }, value: "12" }] },
      { name: "Quiet", firing: [] },
    ])
  })
})
