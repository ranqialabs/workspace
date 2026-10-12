import { expect, test } from "bun:test"

import type { GitHub } from "../src/github/app"
import { OrgDirectory } from "../src/github/directory"

function listForOrg() {}
function listMembers() {}

function fakeGitHub(repos: string[], members: string[], calls: string[]): GitHub {
  return {
    rest: { repos: { listForOrg }, orgs: { listMembers } },
    paginate(method: unknown) {
      calls.push(method === listForOrg ? "repos" : "members")
      return Promise.resolve(
        method === listForOrg
          ? repos.map((full_name) => ({ full_name }))
          : members.map((login) => ({ login })),
      )
    },
  } as unknown as GitHub
}

test("a repo is found by its short or full name in any case", async () => {
  const directory = new OrgDirectory("acme", () =>
    Promise.resolve(fakeGitHub(["acme/Web"], [], [])),
  )
  expect(await directory.repo("web")).toBe("acme/Web")
  expect(await directory.repo("ACME/WEB")).toBe("acme/Web")
  expect(await directory.repo("other/web")).toBeUndefined()
})

test("suggestions put names starting with the text first", async () => {
  const github = fakeGitHub(["acme/web-api", "acme/api", "acme/docs"], [], [])
  const directory = new OrgDirectory("acme", () => Promise.resolve(github))
  expect(await directory.suggestRepos("api")).toEqual(["acme/api", "acme/web-api"])
})

test("lists are fetched once while fresh and again after five minutes", async () => {
  const calls: string[] = []
  let now = 0
  const github = fakeGitHub([], ["Ana"], calls)
  const directory = new OrgDirectory(
    "acme",
    () => Promise.resolve(github),
    () => now,
  )
  expect(await directory.member("ana")).toBe("Ana")
  await directory.suggestMembers("a")
  expect(calls).toEqual(["members"])
  now = 5 * 60 * 1000
  await directory.member("ana")
  expect(calls).toEqual(["members", "members"])
})
