// Release notes. When a deploy to production succeeds, the commits since the
// last one that did are what shipped; the model rewords their subjects for
// people who don't read diffs, and the note goes under the commit's checks
// card. The first deploy bob sees only sets the starting point.
import { generateText, type LanguageModel } from "ai"

import type { Chat } from "../chat/chat"
import type { GitHub } from "../github/app"
import { migrate } from "../store/migrations"
import type { SqlDatabase } from "../store/sql"
import { releaseNote } from "../ui/news"
import type { Newsroom, Published } from "./newsroom"
import { type DeployStep, type PipelineStory, type Story, storyKey } from "./stories"

const STEPS = [
  `CREATE TABLE releases (
    repo TEXT NOT NULL,
    environment TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (repo, environment)
  )`,
]

const MAX_COMMITS = 50

const INSTRUCTIONS = `\
You write release notes for a deploy to production, read by the whole company.
You get the subjects of the commits that went out. Write one to five bullets
saying what changed for the people who use the product, in plain English.
Group related commits, and leave out chores, refactors, tests, version bumps and
dependency updates unless nothing else changed. Cite pull request numbers when a
subject has one, like (#31). Never invent anything the subjects do not say. No
intro, no closing line, no emoji.`

export interface ReleaseDeps {
  github: () => Promise<GitHub>
  model: () => LanguageModel | undefined
}

export class Releases {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newsroom: Newsroom,
    private readonly chats: Chat[],
    private readonly deps: ReleaseDeps,
  ) {
    migrate(db, "releases", STEPS)
  }

  /** Called after each published change; does something only when production just went green. */
  async after({ previous, story }: Published): Promise<void> {
    if (story.kind !== "pipeline") return
    for (const deploy of justShipped(previous, story)) {
      const since = this.lastRelease(story.repo.fullName, deploy.environment)
      this.db.sql.exec(
        `INSERT INTO releases (repo, environment, sha) VALUES (?, ?, ?)
         ON CONFLICT (repo, environment) DO UPDATE SET sha = excluded.sha`,
        story.repo.fullName,
        deploy.environment,
        story.sha,
      )
      if (since === undefined || since === story.sha) continue
      const subjects = await this.subjects(story, since)
      if (subjects.length === 0) continue
      const notes = await this.write(subjects)
      await this.announce(story, deploy.environment, notes)
    }
  }

  private lastRelease(repo: string, environment: string): string | undefined {
    const row = this.db.sql
      .exec<{ sha: string }>(
        "SELECT sha FROM releases WHERE repo = ? AND environment = ?",
        repo,
        environment,
      )
      .next()
    return row.done ? undefined : row.value.sha
  }

  private async subjects(story: PipelineStory, since: string): Promise<string[]> {
    const [owner = "", repo = ""] = story.repo.fullName.split("/")
    const github = await this.deps.github()
    const { data } = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: since,
      head: story.sha,
      per_page: MAX_COMMITS,
    })
    // A rollback compares backwards and has nothing new to announce.
    if (data.status === "behind") return []
    return data.commits.map((commit) => commit.commit.message.split("\n")[0] ?? "")
  }

  private async write(subjects: string[]): Promise<string> {
    const plain = subjects.map((subject) => `- ${subject}`).join("\n")
    const model = this.deps.model()
    if (model === undefined) return plain
    try {
      const { text } = await generateText({ model, system: INSTRUCTIONS, prompt: plain })
      return text.trim() || plain
    } catch (error) {
      console.error("release notes failed", error)
      return plain
    }
  }

  private async announce(story: PipelineStory, environment: string, notes: string): Promise<void> {
    const key = storyKey("pipeline", story.repo.fullName, story.sha)
    for (const chat of this.chats) {
      const card = this.newsroom.card(key, chat.platform)
      if (card === undefined) continue
      await chat.post(card.channel, { text: releaseNote(environment, notes), replyTo: card })
    }
  }
}

/** Production deploys that this change turned green. */
function justShipped(previous: Story | undefined, story: PipelineStory): DeployStep[] {
  const before = previous?.kind === "pipeline" ? previous.steps : []
  return story.steps.filter(
    (step): step is DeployStep =>
      step.type === "deploy" &&
      step.outcome.ok === true &&
      /prod/i.test(step.environment) &&
      !before.some(
        (old) =>
          old.type === "deploy" && old.environment === step.environment && old.outcome.ok === true,
      ),
  )
}
