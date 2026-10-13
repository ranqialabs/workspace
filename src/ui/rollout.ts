// The short-lived card for one of bob's own deploys: how long each step took
// after the commit, up to the slash commands Discord shows.
import type { Card } from "./card"
import { KIND, MARK } from "./glyphs"
import { code, oneLine } from "./text"

export interface Rollout {
  /** The commit the version was built from, when bob could tell. */
  commit?: { sha: string; subject: string; url: string; at: number }
  /** When the version was uploaded, which ends the build. */
  uploadedAt: number
  /** When bob first ran it. */
  liveAt: number
  /** When the changed slash commands reached Discord; absent when they did not change. */
  commandsAt?: number
}

/** `35s`, `2m 05s`, `1h 12m`: the gap between two steps. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function rolloutCard(rollout: Rollout, lifetimeMs: number): Card {
  const start = rollout.commit?.at ?? rollout.uploadedAt
  const step = (label: string, at: number) => `${MARK.done} ${label} · +${elapsed(at - start)}`
  const lines = [
    ...(rollout.commit === undefined
      ? []
      : [`${MARK.done} Committed ${code(rollout.commit.sha.slice(0, 7))}`]),
    step("Built and uploaded", rollout.uploadedAt),
    step("Running", rollout.liveAt),
    rollout.commandsAt === undefined
      ? `${MARK.done} Slash commands unchanged`
      : step("Slash commands updated", rollout.commandsAt),
  ]
  const commit = rollout.commit
  return {
    tone: "green",
    kicker: `${KIND.deploy} bob is live`,
    title: commit === undefined ? "A new version" : oneLine(commit.subject, 120),
    url: commit?.url,
    body: lines.join("\n"),
    footer: `This message deletes itself in ${Math.round(lifetimeMs / 60_000)} min`,
    at: new Date(start).toISOString(),
  }
}
