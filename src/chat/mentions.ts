// Who to notify, in each platform's syntax. Slack's Free plan has no user
// groups, so a repo there has no group to ping and only people are named.
import type { Config, Platform } from "../store/config"
import type { Mentions } from "../ui/card"

export function mentionsFor(config: Config, platform: Platform): Mentions {
  return {
    person(login) {
      const id = config.personBy("github", login)?.[platform] ?? undefined
      return id === undefined || id === null ? undefined : `<@${id}>`
    },
    group(repo) {
      const id = config.accessGroup(repo, platform)
      if (id === undefined) return undefined
      return platform === "discord" ? `<@&${id}>` : `<!subteam^${id}>`
    },
  }
}
