// One per org: the MCP connections to the outside services and the OAuth
// tokens of the ones someone authorized. The Agents SDK's client does the
// protocol and the OAuth flow, and keeps both in this object's SQLite.
//
// Conversations get the catalog and call tools through here: a function does
// not cross Durable Object RPC, so only names, schemas and results do.
import { Lifecycle } from "agents/lifecycle"
import { MCPClientManager } from "agents/mcp/client"
import { DurableObject } from "cloudflare:workers"
import { z } from "zod"

import { chatFor } from "../chat/platforms"
import {
  type AuthorizeResult,
  type CallResult,
  type Catalog,
  type Requester,
  SERVICES,
  serviceFor,
  type ServiceId,
  type ServiceSpec,
  type ServiceState,
} from "./catalog"

export const CALLBACK_PATH = "/services/callback"
const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const MAX_RESULT_CHARS = 12_000

const Called = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
})

export class Services extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("bob", "1.0.0")
  readonly lifecycle = Lifecycle.install(this).use(this.mcp)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) this.ctx.waitUntil(this.announce(result.serverId))
        return page(result.authSuccess, result.serverId, result.authError)
      },
    })
  }

  /** Anything the lifecycle did not take as an OAuth callback. */
  onRequest(): Response {
    return new Response("not found", { status: 404 })
  }

  async catalog(): Promise<Catalog> {
    await this.ready()
    const tools = this.mcp.listTools().flatMap((tool) => {
      const spec = serviceFor(tool.serverId)
      if (spec === undefined) return []
      const description = tool.description ?? ""
      return [
        {
          service: spec.id,
          name: tool.name,
          description,
          inputSchema: JSON.stringify(tool.inputSchema ?? {}),
        },
      ]
    })
    return { services: this.states(), tools }
  }

  async call(service: ServiceId, tool: string, args: Record<string, unknown>): Promise<CallResult> {
    await this.ready()
    const raw = await this.mcp.callTool(
      { serverId: service, name: tool, arguments: args },
      { timeout: CALL_TIMEOUT_MS },
    )
    const result = Called.parse(raw)
    const parts = (result.content ?? []).map((part) => part.text ?? JSON.stringify(part))
    if (parts.length === 0 && result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent))
    }
    const text = parts.join("\n")
    return {
      ok: result.isError !== true,
      text:
        text.length > MAX_RESULT_CHARS
          ? `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated]`
          : text,
    }
  }

  /** The link that authorizes bob on a service, or ready if it already is. */
  async authorize(name: string, requester?: Requester): Promise<AuthorizeResult> {
    await this.ready()
    const spec = serviceFor(name)
    if (spec === undefined) return { kind: "unknown", name }
    if (!spec.oauth || spec.key(this.env) !== undefined) return { kind: "keyed", service: spec.id }
    if (this.mcp.mcpConnections[spec.id]?.connectionState === "ready") {
      return { kind: "ready", service: spec.id, tools: this.toolCount(spec.id) }
    }
    // Start over, so a half-done attempt never hands out a stale link.
    if (this.registered(spec.id)) await this.mcp.removeServer(spec.id)
    await this.mcp.registerServer(spec.id, {
      url: spec.url(this.env),
      name: spec.name,
      callbackUrl: `${this.env.PUBLIC_URL}${CALLBACK_PATH}/${spec.id}`,
      transport: { type: "streamable-http" },
    })
    const result = await this.mcp.connectToServer(spec.id)
    if (result.state === "failed") return { kind: "failed", service: spec.id, error: result.error }
    if (result.state === "authenticating") {
      if (requester !== undefined) this.ctx.storage.kv.put(`requester:${spec.id}`, requester)
      return { kind: "link", service: spec.id, url: result.authUrl }
    }
    await this.mcp.discoverIfConnected(spec.id)
    return { kind: "ready", service: spec.id, tools: this.toolCount(spec.id) }
  }

  /** Drops a service's connection and tokens. A keyed one comes back on the next catalog. */
  async forget(name: string): Promise<ServiceId | undefined> {
    await this.lifecycle.start()
    const spec = serviceFor(name)
    if (spec === undefined) return undefined
    if (this.registered(spec.id)) await this.mcp.removeServer(spec.id)
    this.ctx.storage.kv.delete(`stamp:${spec.id}`)
    return spec.id
  }

  /** Registers the keyed services (again when the key changed) and retries failed ones. */
  private async ready(): Promise<void> {
    await this.lifecycle.start()
    for (const spec of SERVICES) {
      const key = spec.key(this.env)
      if (key === undefined) continue
      const stamp = await fingerprint(`${spec.url(this.env)} ${JSON.stringify(key)}`)
      const registered = this.registered(spec.id)
      if (registered && this.ctx.storage.kv.get(`stamp:${spec.id}`) === stamp) continue
      if (registered) await this.mcp.removeServer(spec.id)
      await this.mcp.registerServer(spec.id, {
        url: spec.url(this.env),
        name: spec.name,
        transport: { type: "streamable-http", requestInit: { headers: key } },
      })
      this.ctx.storage.kv.put(`stamp:${spec.id}`, stamp)
      await this.start(spec)
    }
    for (const spec of SERVICES) {
      if (this.mcp.mcpConnections[spec.id]?.connectionState === "failed") await this.start(spec)
    }
    await this.mcp.waitForConnections({ timeout: CONNECT_TIMEOUT_MS })
  }

  private async start(spec: ServiceSpec): Promise<void> {
    const result = await this.mcp.connectToServer(spec.id)
    if (result.state === "connected") {
      await this.mcp.discoverIfConnected(spec.id, { timeoutMs: CONNECT_TIMEOUT_MS })
    }
  }

  private registered(id: ServiceId): boolean {
    return this.mcp.listServers().some((row) => row.id === id)
  }

  private toolCount(id: ServiceId): number {
    return this.mcp.listTools({ serverId: id }).length
  }

  private states(): ServiceState[] {
    return SERVICES.map((spec) => {
      const auth = spec.oauth && spec.key(this.env) === undefined ? "oauth" : "key"
      const connection = this.mcp.mcpConnections[spec.id]
      if (connection === undefined || !this.registered(spec.id)) {
        return { id: spec.id, name: spec.name, state: "absent", auth, tools: 0 }
      }
      const error = connection.connectionError
      return {
        id: spec.id,
        name: spec.name,
        state: connection.connectionState,
        auth,
        ...(error ? { error } : {}),
        tools: this.toolCount(spec.id),
      }
    })
  }

  private async announce(id: string): Promise<void> {
    const spec = serviceFor(id)
    const requester = spec && this.ctx.storage.kv.get<Requester>(`requester:${spec.id}`)
    if (spec === undefined || requester === undefined) return
    this.ctx.storage.kv.delete(`requester:${spec.id}`)
    await this.mcp.waitForConnections({ timeout: CONNECT_TIMEOUT_MS })
    const by = requester.user === undefined ? "" : ` by <@${requester.user}>`
    try {
      await chatFor(this.env, requester.platform).post(requester.channel, {
        text: `✅ ${spec.name} is connected${by}. bob can use its ${this.toolCount(spec.id)} tools from the next message on.`,
      })
    } catch (error) {
      console.error("could not announce a connected service", error)
    }
  }
}

async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Where the browser lands after authorizing. */
function page(success: boolean, id: string | undefined, error: string | undefined): Response {
  const name = escape(serviceFor(id ?? "")?.name ?? "The service")
  const body = success
    ? `<h1>${name} is connected to bob</h1><p>You can close this tab and go back to the chat.</p>`
    : `<h1>bob could not connect ${name}</h1><p>${escape(error ?? "Unknown error")}</p><p>Ask bob for a new link and try again.</p>`
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>bob</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem}</style>${body}`,
    { status: success ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

function escape(text: string): string {
  return text.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}
