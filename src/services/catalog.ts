// The outside services bob reaches through MCP. A secret key connects some;
// the rest connect once someone authorizes bob in the browser.

export const SERVICE_IDS = ["dorothy", "cloudflare", "posthog"] as const
export type ServiceId = (typeof SERVICE_IDS)[number]

export interface ServiceEnv {
  DOROTHY_API_KEY?: string
  DOROTHY_MCP_URL?: string
  CLOUDFLARE_MCP_TOKEN?: string
  POSTHOG_MCP_TOKEN?: string
}

export interface ServiceSpec {
  id: ServiceId
  name: string
  url(env: ServiceEnv): string
  /** Headers from a secret; without them the service connects by OAuth. */
  key(env: ServiceEnv): Record<string, string> | undefined
  oauth: boolean
  /** What the model reads about it. */
  about: string
}

function bearer(token: string | undefined): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

export const SERVICES: readonly ServiceSpec[] = [
  {
    id: "dorothy",
    name: "Dorothy",
    // Without the trailing slash the server answers with a redirect.
    url: (env) => env.DOROTHY_MCP_URL ?? "https://dorothy.ranqia.io/mcp/",
    key: (env) => (env.DOROTHY_API_KEY ? { "x-api-key": env.DOROTHY_API_KEY } : undefined),
    oauth: false,
    about:
      "Dorothy builds and hosts the customers' sites: sites and their items, domains, deploys, traffic, search performance and SEO reports. Its tools change production at once: creating, changing or deleting a site, item or domain, pointing a domain, triggering a deploy. Do those only when someone clearly asked, say what you are about to do, and report what it did.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    url: () => "https://mcp.cloudflare.com/mcp",
    key: (env) => bearer(env.CLOUDFLARE_MCP_TOKEN),
    oauth: true,
    about:
      "The Cloudflare API (Workers and their logs and builds, DNS, R2, KV, D1): `search` finds an endpoint, `execute` calls it. Write only when asked.",
  },
  {
    id: "posthog",
    name: "PostHog",
    url: () => "https://mcp.posthog.com/mcp",
    key: (env) => bearer(env.POSTHOG_MCP_TOKEN),
    oauth: true,
    about:
      "PostHog, the product analytics: events, insights, funnels, HogQL, feature flags, experiments and errors. Write only when asked.",
  },
]

export function serviceFor(name: string): ServiceSpec | undefined {
  const wanted = name.trim().toLowerCase()
  return SERVICES.find((spec) => spec.id === wanted)
}

export type ServiceStateName =
  | "ready"
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "failed"
  /** No key, and nobody has authorized it yet. */
  | "absent"

export interface ServiceState {
  id: ServiceId
  name: string
  state: ServiceStateName
  auth: "key" | "oauth"
  error?: string
  tools: number
}

/** A remote tool as plain data, so it crosses Durable Object RPC. */
export interface RemoteTool {
  service: ServiceId
  name: string
  description: string
  /** The JSON Schema, as JSON text. */
  inputSchema: string
}

export interface Catalog {
  services: ServiceState[]
  tools: RemoteTool[]
}

export interface CallResult {
  ok: boolean
  text: string
}

export type AuthorizeResult =
  | { kind: "ready"; service: ServiceId; tools: number }
  | { kind: "link"; service: ServiceId; url: string }
  | { kind: "keyed"; service: ServiceId }
  | { kind: "unknown"; name: string }
  | { kind: "failed"; service: ServiceId; error: string }

/** Where to say a service got connected once the browser comes back. */
export interface Requester {
  platform: "discord" | "slack"
  channel: string
  user?: string
}

/** `dorothy_list_sites`, within the 64 characters the chat API allows. */
export function toolName(service: ServiceId, tool: string): string {
  return `${service}_${tool.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64)
}

export function servicesInstructions(services: ServiceState[]): string {
  const parts: string[] = []
  const ready = services.filter((service) => service.state === "ready")
  if (ready.length > 0) {
    const lines = ready.map(
      (service) => `- ${service.name}, tools \`${service.id}_*\`: ${serviceFor(service.id)?.about}`,
    )
    parts.push(`You also reach these services through their tools:\n${lines.join("\n")}`)
  }
  const missing = services.filter(
    (service) => service.state !== "ready" && service.auth === "oauth",
  )
  if (missing.length > 0) {
    const names = missing.map((service) => service.name).join(", ")
    parts.push(
      `Not connected yet: ${names}. When a question needs one, call \`connect_service\` and give the person the link. Once someone authorizes it, its tools are there from the next message on.`,
    )
  }
  return parts.join("\n\n")
}
