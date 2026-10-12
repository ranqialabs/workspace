// An Octokit whose endpoints answer from a table, for tools and filing issues.
import type { GitHub } from "../../src/github/app"

export type Calls = { method: string; params: Record<string, unknown> }[]

/**
 * An Octokit whose endpoints answer from `answers` and record what they were
 * asked. An answer that is a function is called with the request's parameters.
 */
export function fakeGitHub(answers: Record<string, unknown>, calls: Calls = []): GitHub {
  const rest = new Proxy(
    {},
    {
      get: (_, namespace: string) =>
        new Proxy(
          {},
          {
            get: (__, name: string) => (params: Record<string, unknown>) => {
              const method = `${namespace}.${name}`
              calls.push({ method, params })
              const entry = answers[method]
              const answer = typeof entry === "function" ? entry(params) : entry
              if (answer instanceof Error) return Promise.reject(answer)
              return Promise.resolve({ data: answer })
            },
          },
        ),
    },
  )
  return { rest } as unknown as GitHub
}
