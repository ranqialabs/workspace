// The Python bob kept its configuration as its own messages in a #bot-config
// channel, one line per mapping, and rebuilt it by replaying the channel.
// `/import` reads that channel once into SQLite, so moving to this version
// does not mean mapping every repo and person again.
import { z } from "zod"

import type { Config } from "../store/config"
import { DiscordMessage } from "./inbound"
import type { DiscordRest } from "./rest"

// `github [octocat](https://github.com/octocat) <@123>`; `identity` is the
// oldest name for `github`. The plain form `repo owner/name 789` came before
// the links and may still sit at the top of an old channel.
const LINE =
  /^(github|identity|linear|repo|announce|access)\s+\[([^\]]+)\]\([^)]*\)\s+<(?:@&|@|#)(\d+)>$/
const PLAIN = /^(github|identity|repo|announce|access)\s+(\S+)\s+(\d+)$/

/** How far back to read; the Python channel held a few dozen lines. */
const PAGES = 10

export interface Imported {
  repos: number
  announce: number
  access: number
  accounts: number
}

/** Applies config lines oldest first, so a later line for the same key wins, as it did in Python. */
export function applyLines(config: Config, lines: string[]): Imported {
  const counts: Imported = { repos: 0, announce: 0, access: 0, accounts: 0 }
  for (const line of lines) {
    const match = LINE.exec(line.trim()) ?? PLAIN.exec(line.trim())
    if (match === null) continue
    const [, kind, key = "", id = ""] = match
    if (kind === "repo") {
      config.mapChannel(key, "discord", "home", id)
      counts.repos += 1
    } else if (kind === "announce") {
      config.mapChannel(key, "discord", "announce", id)
      counts.announce += 1
    } else if (kind === "access") {
      config.setAccessGroup(key, "discord", id)
      counts.access += 1
    } else if (kind === "linear") {
      config.link("discord", id, "linear", key)
      counts.accounts += 1
    } else {
      config.link("discord", id, "github", key)
      counts.accounts += 1
    }
  }
  return counts
}

/** Every line bob itself wrote in `channel`, oldest first. */
export async function readLines(rest: DiscordRest, channel: string): Promise<string[]> {
  const messages: DiscordMessage[] = []
  let before: string | undefined
  for (let page = 0; page < PAGES; page++) {
    const query = new URLSearchParams({ limit: "100" })
    if (before !== undefined) query.set("before", before)
    const raw = await rest.get(`/channels/${channel}/messages?${query.toString()}`)
    const batch = z.array(DiscordMessage).parse(raw)
    messages.push(...batch)
    if (batch.length < 100) break
    before = batch.at(-1)?.id
  }
  // Discord pages newest first; only bob's own messages are configuration.
  return messages
    .filter((message) => message.author.bot === true)
    .toReversed()
    .flatMap((message) => message.content.split("\n"))
}
