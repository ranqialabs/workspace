// The slash commands as Discord's bulk overwrite endpoint takes them. Admin
// commands need Manage Server, so Discord greys them out for everyone else.
const STRING = 3
const BOOLEAN = 5
const USER = 6
const CHANNEL = 7
const SUBCOMMAND = 1
const GUILD_TEXT = 0
const IN_SERVERS = [0]
const MANAGE_GUILD = String(1 << 5)

function picked(name: string, description: string) {
  return { type: STRING, name, description, required: true, autocomplete: true }
}

const repo = picked("repo", "A repo in the org")
const channel = {
  type: CHANNEL,
  name: "channel",
  description: "The channel",
  required: true,
  channel_types: [GUILD_TEXT],
}
const member = { type: USER, name: "member", description: "The member", required: true }

function subcommand(name: string, description: string, options: object[]) {
  return { type: SUBCOMMAND, name, description, options }
}

export const COMMANDS = [
  {
    name: "map",
    description: "Map repos to channels and people to their accounts",
    default_member_permissions: MANAGE_GUILD,
    contexts: IN_SERVERS,
    options: [
      subcommand("repo", "Make a channel a repo's home: its news, and the issues drafted there", [
        repo,
        channel,
      ]),
      subcommand("announce", "Send a repo's news to a channel other than its home", [
        repo,
        channel,
      ]),
      subcommand("github", "Say who a GitHub login is on this server", [
        picked("login", "A member of the GitHub org"),
        member,
      ]),
      subcommand("linear", "Say who a Linear account is on this server", [
        picked("email", "Their Linear email"),
        member,
      ]),
      subcommand("retro", "Post the daily and weekly retros in a channel", [channel]),
    ],
  },
  {
    name: "unmap",
    description: "Undo a mapping",
    default_member_permissions: MANAGE_GUILD,
    contexts: IN_SERVERS,
    options: [
      subcommand("repo", "Forget a repo's channel", [
        repo,
        {
          type: BOOLEAN,
          name: "announce",
          description: "Forget only its announce channel",
          required: false,
        },
      ]),
      subcommand("github", "Forget someone's GitHub login", [member]),
      subcommand("linear", "Forget someone's Linear account", [member]),
      subcommand("retro", "Stop posting the retros", []),
    ],
  },
  {
    name: "import",
    description: "Read the old #bot-config channel once into bob's configuration",
    contexts: IN_SERVERS,
    default_member_permissions: MANAGE_GUILD,
    options: [{ ...channel, description: "The old #bot-config channel" }],
  },
  {
    name: "retro",
    description: "Post what shipped today, or this week, in this channel",
    contexts: IN_SERVERS,
    options: [
      {
        type: STRING,
        name: "period",
        description: "Today, or this week so far",
        required: false,
        choices: [
          { name: "today", value: "day" },
          { name: "this week", value: "week" },
        ],
      },
    ],
  },
  {
    name: "connect",
    description: "See the services bob uses, or get the link that connects one",
    contexts: IN_SERVERS,
    options: [
      {
        type: STRING,
        name: "service",
        description: "The service to connect",
        required: false,
        choices: [
          { name: "Cloudflare", value: "cloudflare" },
          { name: "PostHog", value: "posthog" },
        ],
      },
    ],
  },
  {
    name: "disconnect",
    description: "Make bob forget a service's connection",
    contexts: IN_SERVERS,
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        type: STRING,
        name: "service",
        description: "The service",
        required: true,
        choices: [
          { name: "Dorothy", value: "dorothy" },
          { name: "Cloudflare", value: "cloudflare" },
          { name: "PostHog", value: "posthog" },
        ],
      },
    ],
  },
  {
    name: "config",
    description: "Show what bob knows: repos, channels and people",
    contexts: IN_SERVERS,
  },
]
