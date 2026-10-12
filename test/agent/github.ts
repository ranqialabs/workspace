// An Octokit whose endpoints answer from a table, for tools and Submit.
import type { GitHub } from "../../src/github/app"

export type Calls = { method: string; params: Record<string, unknown> }[]

/** An Octokit whose endpoints answer from `answers` and record what they were asked. */
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
              const answer = answers[method]
              if (answer instanceof Error) return Promise.reject(answer)
              return Promise.resolve({ data: answer })
            },
          },
        ),
    },
  )
  return { rest } as unknown as GitHub
}
