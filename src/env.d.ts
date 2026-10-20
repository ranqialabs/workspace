// Secrets that switch a part of bob on. `wrangler types` lists only required
// secrets, and each of these is optional: leave Slack's out and bob runs on
// Discord alone, and the other way round.
interface Env {
  DISCORD_TOKEN?: string
  DISCORD_PUBLIC_KEY?: string
  DISCORD_GUILD_ID?: string
  SLACK_BOT_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
  DEEPSEEK_API_KEY?: string
  LINEAR_API_KEY?: string
  /** A Viewer service account token for Sauron, the team's Grafana. */
  SAURON_TOKEN?: string
  SAURON_URL?: string
  /** The key of Dorothy's MCP server, the same as its API's. */
  DOROTHY_API_KEY?: string
  DOROTHY_MCP_URL?: string
  /** Keys that stand in for authorizing Cloudflare or PostHog in the browser. */
  CLOUDFLARE_MCP_TOKEN?: string
  POSTHOG_MCP_TOKEN?: string
}

// Fonts are bundled as data (see `rules` in wrangler.jsonc) for the images bob draws.
declare module "*.woff" {
  const data: ArrayBuffer
  export default data
}
