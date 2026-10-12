// The org's repos and members, as the commands check them and autocomplete
// offers them. Discord drops an autocomplete answer after three seconds, so
// the lists are kept for a few minutes instead of listed on every keystroke.
import type { Directory } from "../commands"
import type { GitHub } from "./app"

const FRESH_FOR = 5 * 60 * 1000
const SUGGESTIONS = 25

interface Listing {
  names: string[]
  at: number
}

export class OrgDirectory implements Directory {
  private repoListing: Listing | undefined
  private memberListing: Listing | undefined

  constructor(
    private readonly org: string,
    private readonly github: () => Promise<GitHub>,
    private readonly now: () => number = Date.now,
  ) {}

  async repo(name: string): Promise<string | undefined> {
    return find(await this.repos(), name.includes("/") ? name : `${this.org}/${name}`)
  }

  async member(login: string): Promise<string | undefined> {
    return find(await this.members(), login)
  }

  async suggestRepos(typed: string): Promise<string[]> {
    return suggest(await this.repos(), typed)
  }

  async suggestMembers(typed: string): Promise<string[]> {
    return suggest(await this.members(), typed)
  }

  private async repos(): Promise<string[]> {
    if (!this.fresh(this.repoListing)) {
      const github = await this.github()
      const repos = await github.paginate(github.rest.repos.listForOrg, {
        org: this.org,
        per_page: 100,
      })
      this.repoListing = { names: repos.map((repo) => repo.full_name), at: this.now() }
    }
    return this.repoListing.names
  }

  private async members(): Promise<string[]> {
    if (!this.fresh(this.memberListing)) {
      const github = await this.github()
      const members = await github.paginate(github.rest.orgs.listMembers, {
        org: this.org,
        per_page: 100,
      })
      this.memberListing = { names: members.map((member) => member.login), at: this.now() }
    }
    return this.memberListing.names
  }

  private fresh(listing: Listing | undefined): listing is Listing {
    return listing !== undefined && this.now() - listing.at < FRESH_FOR
  }
}

function find(names: string[], wanted: string): string | undefined {
  const lower = wanted.toLowerCase()
  return names.find((name) => name.toLowerCase() === lower)
}

/** Names containing what was typed, those that start with it first. */
function suggest(names: string[], typed: string): string[] {
  const lower = typed.toLowerCase()
  const matches = names.filter((name) => name.toLowerCase().includes(lower))
  const starts = (name: string) => name.toLowerCase().split("/").pop()?.startsWith(lower) ?? false
  return matches.toSorted((a, b) => Number(starts(b)) - Number(starts(a))).slice(0, SUGGESTIONS)
}
