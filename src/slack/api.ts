// A small client for Slack's Web API. Every call is a form POST with the bot
// token, the one encoding all methods accept (several read methods refuse
// JSON); nested values such as `blocks` go as JSON strings. Slack answers 200
// with `ok: false` for most errors and 429 with `Retry-After` when rate
// limited, which is waited out a few times.
import { z } from "zod"

const API = "https://slack.com/api/"
const ATTEMPTS = 3

export type Fetch = (request: Request) => Promise<Response>

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`)
  }
}

const Answer = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

export class SlackApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (request) => fetch(request),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async call(method: string, body: object): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetcher(
        new Request(API + method, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}` },
          body: form(body),
        }),
      )
      if (response.status === 429 && attempt < ATTEMPTS) {
        const seconds = Number(response.headers.get("retry-after") ?? "1")
        await this.sleep(Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000))
        continue
      }
      if (!response.ok) throw new SlackError(method, `HTTP ${response.status}`)
      const answer = Answer.parse(await response.json())
      if (!answer.ok) throw new SlackError(method, answer.error ?? "unknown_error")
      return answer
    }
  }
}

function form(body: object): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    params.set(key, typeof value === "string" ? value : JSON.stringify(value))
  }
  return params
}
