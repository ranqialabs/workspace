// A small client for the parts of Discord's REST API bob uses. Rate limits
// are honored by waiting out `retry_after` and trying again, a few times.
import { z } from "zod"

const API = "https://discord.com/api/v10"
const ATTEMPTS = 3

export type Fetch = (request: Request) => Promise<Response>

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    detail: string,
  ) {
    super(`Discord ${status} on ${route}: ${detail}`)
  }
}

const RateLimited = z.object({ retry_after: z.number() })

export class DiscordRest {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (request) => fetch(request),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async request(method: string, route: string, body?: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetcher(
        new Request(API + route, {
          method,
          headers: {
            authorization: `Bot ${this.token}`,
            "content-type": "application/json",
            "user-agent": "DiscordBot (https://github.com/ranqialabs/workspace, 2)",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      if (response.status === 204) return undefined
      if (response.status === 429 && attempt < ATTEMPTS) {
        const limited = RateLimited.safeParse(await response.json())
        await this.sleep(Math.ceil((limited.success ? limited.data.retry_after : 1) * 1000))
        continue
      }
      if (!response.ok)
        throw new DiscordError(response.status, `${method} ${route}`, await response.text())
      const parsed: unknown = await response.json()
      return parsed
    }
  }

  get(route: string): Promise<unknown> {
    return this.request("GET", route)
  }

  post(route: string, body?: unknown): Promise<unknown> {
    return this.request("POST", route, body)
  }

  patch(route: string, body?: unknown): Promise<unknown> {
    return this.request("PATCH", route, body)
  }

  put(route: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", route, body)
  }

  delete(route: string): Promise<unknown> {
    return this.request("DELETE", route)
  }
}
