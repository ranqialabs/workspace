// Secrets that switch a part of bob on. `wrangler types` lists only required
// secrets, and each of these is optional: leave Slack's out and bob runs on
// Discord alone, and the other way round.
interface Env {
  DISCORD_TOKEN?: string
  DISCORD_PUBLIC_KEY?: string
  DISCORD_GUILD_ID?: string
  SLACK_BOT_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
  OPENAI_API_KEY?: string
  LINEAR_API_KEY?: string
}
