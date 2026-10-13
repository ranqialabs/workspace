// What bob says back to an admin command, and the configuration card. Replies
// are shown only to whoever ran the command. A mistake says how to fix it.
import type { Result } from "../commands"
import type { Account, Config, Platform } from "../store/config"
import type { Card } from "./card"
import { KIND, MARK } from "./glyphs"
import { code, count, listed, repoName } from "./text"

export interface Reply {
  text: string
  cards?: Card[]
}

const ACCOUNT: Record<Account, string> = { github: "GitHub", linear: "Linear" }
const PLATFORM: Record<Platform, string> = { discord: "Discord", slack: "Slack" }
// How to run a command on each platform, for the hints in empty states.
const SLASH: Record<Platform, string> = { discord: "/", slack: "/bob " }

export function commandReply(result: Result, config: Config, platform: Platform): Reply {
  switch (result.kind) {
    case "repo-mapped":
      return {
        text:
          result.purpose === "home"
            ? `${MARK.done} <#${result.channel}> is now home to ${code(result.repo)}: its news, and the issues drafted there.`
            : `${MARK.done} News from ${code(result.repo)} now goes to <#${result.channel}>.`,
      }
    case "repo-unknown":
      return {
        text: `No repo called ${code(result.name)} in the org. Check the spelling, and that the GitHub App is installed on it.`,
      }
    case "repo-unmapped":
      return {
        text:
          result.purpose === "home"
            ? `${code(result.repo)} has no home channel on ${PLATFORM[platform]} anymore.`
            : `News from ${code(result.repo)} goes back to its home channel.`,
      }
    case "person-linked":
      return {
        text: `${MARK.done} <@${result.user}> is ${code(result.value)} on ${ACCOUNT[result.account]}.`,
      }
    case "not-a-member":
      return {
        text: `${code(result.login)} is not a member of the GitHub org. Copy the login from their GitHub profile.`,
      }
    case "person-unlinked":
      return {
        text: `<@${result.user}> has no ${ACCOUNT[result.account]} account linked anymore.`,
      }
    case "imported": {
      const { repos, announce, access, accounts } = result.counts
      const parts = [
        count(repos, "home channel"),
        count(announce, "announce channel"),
        count(access, "access role"),
        count(accounts, "linked account"),
      ].filter((part) => !part.startsWith("0 "))
      const what = parts.length > 0 ? listed(parts) : "nothing to import"
      return {
        text: `${MARK.done} Read <#${result.channel}>: ${what}.`,
        cards: [configCard(config, platform)],
      }
    }
    case "place-mapped":
      return {
        text: `${MARK.done} The daily and weekly retros now go to <#${result.channel}>, on working days at 18:00.`,
      }
    case "place-unmapped":
      return { text: `The retro has no channel on ${PLATFORM[platform]} anymore.` }
    case "retro-posted":
      return {
        text: `${MARK.done} Posted the ${result.period === "day" ? "daily" : "weekly"} retro.`,
      }
    case "discord-only":
      return { text: "Importing works on Discord only, from the old #bot-config channel." }
    case "config":
      break
  }
  return { text: "", cards: [configCard(config, platform)] }
}

/** Everything bob knows on one platform, drawn from the database every time. */
export function configCard(config: Config, platform: Platform): Card {
  const repos = new Map<string, { home?: string; announce?: string }>()
  for (const mapping of config.channels(platform)) {
    repos.set(mapping.repo, { ...repos.get(mapping.repo), [mapping.purpose]: mapping.channel })
  }
  const repoLines = [...repos].map(([repo, channels]) => {
    const parts: string[] = []
    if (channels.home !== undefined) parts.push(`<#${channels.home}>`)
    if (channels.announce !== undefined) parts.push(`news in <#${channels.announce}>`)
    const group = config.accessGroup(repo, platform)
    if (group !== undefined && platform === "discord") parts.push(`access <@&${group}>`)
    return `**${repoName(repo)}** ${parts.join(", ")}`
  })
  const peopleLines = config
    .people()
    .filter((person) => person[platform] !== null)
    .map((person) => {
      const accounts: string[] = []
      if (person.github !== null) accounts.push(`${code(person.github)} on GitHub`)
      if (person.linear !== null) accounts.push(`${code(person.linear)} on Linear`)
      return `<@${person[platform]}> is ${listed(accounts)}`
    })
  const slash = SLASH[platform]
  const retro = config.place("retro", platform)
  const body = [
    "**Repos**",
    ...(repoLines.length > 0 ? repoLines : [`None yet. Add one with ${code(`${slash}map repo`)}.`]),
    "",
    "**People**",
    ...(peopleLines.length > 0
      ? peopleLines
      : [`Nobody yet. Link someone with ${code(`${slash}map github`)}.`]),
    "",
    "**Retro**",
    retro === undefined
      ? `Not posted. Choose a channel with ${code(`${slash}map retro`)}.`
      : `<#${retro}>, on working days at 18:00`,
  ].join("\n")
  return {
    tone: "brand",
    kicker: `${KIND.config} Configuration`,
    title: `What bob knows on ${PLATFORM[platform]}`,
    body,
  }
}
