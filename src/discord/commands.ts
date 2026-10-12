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
    description: "Tie repos and people to this server",
    default_member_permissions: MANAGE_GUILD,
    contexts: IN_SERVERS,
    options: [
      subcommand("repo", "A repo's home channel: its news, access and conversations", [
        repo,
        channel,
      ]),
      subcommand("announce", "Send a repo's news to another channel than its home", [
        repo,
        channel,
      ]),
      subcommand("github", "Who a GitHub login is here", [
        picked("login", "A member of the GitHub org"),
        member,
      ]),
      subcommand("linear", "Who a Linear account is here", [
        picked("email", "Their Linear email"),
        member,
      ]),
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
    ],
  },
  {
    name: "config",
    description: "Show what bob knows: repos, channels and people",
    contexts: IN_SERVERS,
  },
]
