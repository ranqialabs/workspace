// The admin commands, the same on both platforms. Each platform turns its own
// input (Discord options, Slack text) into a Command, and shows the reply
// only to whoever ran it.
import type { Card } from "./chat/card"
import type { Account, Config, Platform, Purpose } from "./store/config"

export type Command =
  | { name: "map-repo"; repo: string; channel: string; purpose: Purpose }
  | { name: "unmap-repo"; repo: string; purpose: Purpose }
  | { name: "map-person"; account: Account; value: string; user: string; userName?: string }
  | { name: "unmap-person"; account: Account; user: string }
  | { name: "config" }
  /** Discord only: reads the Python version's #bot-config once. */
  | { name: "import"; channel: string }

export interface Reply {
  text: string
  cards?: Card[]
}

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
): Promise<Reply> {
  switch (command.name) {
    case "map-repo": {
      const repo = await directory.repo(command.repo)
      if (repo === undefined) return { text: `I can't find a repo called \`${command.repo}\`.` }
      config.mapChannel(repo, platform, command.purpose, command.channel)
      const role = command.purpose === "home" ? "news and conversations" : "news"
      return { text: `\`${repo}\` now sends its ${role} to <#${command.channel}>.` }
    }
    case "unmap-repo": {
      config.unmapChannel(command.repo, platform, command.purpose)
      const what = command.purpose === "home" ? "home channel" : "announce channel"
      return { text: `\`${command.repo}\` has no ${what} here anymore.` }
    }
    case "map-person": {
      const value =
        command.account === "github" ? await directory.member(command.value) : command.value
      if (value === undefined) {
        return { text: `\`${command.value}\` is not a member of the GitHub org.` }
      }
      config.link(platform, command.user, command.account, value, command.userName)
      const label = command.account === "github" ? "GitHub" : "Linear"
      return { text: `<@${command.user}> is \`${value}\` on ${label}.` }
    }
    case "unmap-person": {
      config.unlink(platform, command.user, command.account)
      const label = command.account === "github" ? "GitHub" : "Linear"
      return { text: `<@${command.user}> has no ${label} account linked anymore.` }
    }
    case "import":
      return { text: "Importing only works on Discord, from the old #bot-config channel." }
    case "config":
      break
  }
  return { text: "", cards: [configCard(config, platform)] }
}

/** Everything bob knows, as one card; it is drawn from the database every time. */
export function configCard(config: Config, platform: Platform): Card {
  const repos = new Map<string, { home?: string; announce?: string }>()
  for (const mapping of config.channels(platform)) {
    repos.set(mapping.repo, { ...repos.get(mapping.repo), [mapping.purpose]: mapping.channel })
  }
  const repoLines = [...repos].map(([repo, channels]) => {
    const parts = [`**${repo}**`]
    if (channels.home !== undefined) parts.push(`<#${channels.home}>`)
    if (channels.announce !== undefined) parts.push(`news in <#${channels.announce}>`)
    const group = config.accessGroup(repo, platform)
    if (group !== undefined && platform === "discord") parts.push(`<@&${group}>`)
    return parts.join(" · ")
  })
  const peopleLines = config
    .people()
    .filter((person) => person[platform] !== null)
    .map((person) => {
      const parts = [`<@${person[platform]}>`]
      if (person.github !== null) parts.push(`GitHub \`${person.github}\``)
      if (person.linear !== null) parts.push(`Linear \`${person.linear}\``)
      return parts.join(" · ")
    })
  const body = [
    "**Repos**",
    ...(repoLines.length > 0 ? repoLines : ["None yet. Map one with `map repo`."]),
    "",
    "**People**",
    ...(peopleLines.length > 0 ? peopleLines : ["Nobody yet. Link someone with `map github`."]),
  ].join("\n")
  return { tone: "brand", kicker: "bob · configuration", title: "What bob knows", body }
}
