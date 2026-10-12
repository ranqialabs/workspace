// The admin commands, the same on both platforms. Each platform turns its own
// input (Discord options, Slack text) into a Command; running it changes the
// configuration and says what happened, and `ui/commands` words the reply.
import type { Imported } from "./discord/legacy"
import type { Account, Config, Platform, Purpose } from "./store/config"

export type Command =
  | { name: "map-repo"; repo: string; channel: string; purpose: Purpose }
  | { name: "unmap-repo"; repo: string; purpose: Purpose }
  | { name: "map-person"; account: Account; value: string; user: string; userName?: string }
  | { name: "unmap-person"; account: Account; user: string }
  | { name: "config" }
  /** Discord only: reads the Python version's #bot-config once. */
  | { name: "import"; channel: string }

/** What a command did. `ui/commands` says it back to whoever ran it. */
export type Result =
  | { kind: "repo-mapped"; repo: string; channel: string; purpose: Purpose }
  | { kind: "repo-unknown"; name: string }
  | { kind: "repo-unmapped"; repo: string; purpose: Purpose }
  | { kind: "person-linked"; user: string; account: Account; value: string }
  | { kind: "not-a-member"; login: string }
  | { kind: "person-unlinked"; user: string; account: Account }
  | { kind: "imported"; channel: string; counts: Imported }
  | { kind: "discord-only" }
  | { kind: "config" }

/** What the commands need checked against the outside world before saving. */
export interface Directory {
  /** The repo's full name as GitHub spells it, or undefined if the org has no such repo. */
  repo(name: string): Promise<string | undefined>
  /** The login as GitHub spells it, or undefined if the org has no such member. */
  member(login: string): Promise<string | undefined>
}

export async function run(
  command: Command,
  platform: Platform,
  config: Config,
  directory: Directory,
): Promise<Result> {
  switch (command.name) {
    case "map-repo": {
      const repo = await directory.repo(command.repo)
      if (repo === undefined) return { kind: "repo-unknown", name: command.repo }
      config.mapChannel(repo, platform, command.purpose, command.channel)
      return { kind: "repo-mapped", repo, channel: command.channel, purpose: command.purpose }
    }
    case "unmap-repo":
      config.unmapChannel(command.repo, platform, command.purpose)
      return { kind: "repo-unmapped", repo: command.repo, purpose: command.purpose }
    case "map-person": {
      const value =
        command.account === "github" ? await directory.member(command.value) : command.value
      if (value === undefined) return { kind: "not-a-member", login: command.value }
      config.link(platform, command.user, command.account, value, command.userName)
      return { kind: "person-linked", user: command.user, account: command.account, value }
    }
    case "unmap-person":
      config.unlink(platform, command.user, command.account)
      return { kind: "person-unlinked", user: command.user, account: command.account }
    case "import":
      // Reading Discord history needs the bot's token, so the Workspace does it.
      return { kind: "discord-only" }
    case "config":
      break
  }
  return { kind: "config" }
}
