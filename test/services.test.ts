import { describe, expect, test } from "bun:test"

import { type ServicesPort, servicesTools } from "../src/agent/tools/services"
import type { Step } from "../src/agent/progress"
import {
  type AuthorizeResult,
  type Catalog,
  SERVICES,
  servicesInstructions,
  toolName,
} from "../src/services/catalog"
import { toCommand } from "../src/slack/inbound"
import { commandReply } from "../src/ui/commands"
import { stepLine } from "../src/ui/progress"
import { memoryDatabase } from "./memory-database"
import { Config } from "../src/store/config"

const CATALOG: Catalog = {
  services: [
    { id: "dorothy", name: "Dorothy", state: "ready", auth: "key", tools: 1 },
    { id: "cloudflare", name: "Cloudflare", state: "absent", auth: "oauth", tools: 0 },
    { id: "posthog", name: "PostHog", state: "ready", auth: "oauth", tools: 0 },
  ],
  tools: [
    {
      service: "dorothy",
      name: "get_site",
      description: "A site",
      inputSchema: JSON.stringify({
        type: "object",
        properties: { site_id: { type: "string" } },
        required: ["site_id"],
      }),
    },
  ],
}

function fakePort(
  authorized: AuthorizeResult = { kind: "link", service: "posthog", url: "https://x" },
) {
  const calls: unknown[][] = []
  const port: ServicesPort = {
    catalog: () => Promise.resolve(CATALOG),
    call: (service, tool, args) => {
      calls.push([service, tool, args])
      return Promise.resolve(
        args.site_id === "gone"
          ? { ok: false, text: "site not found" }
          : { ok: true, text: "site a" },
      )
    },
    authorize: (name, requester) => {
      calls.push(["authorize", name, requester])
      return Promise.resolve(authorized)
    },
  }
  return { port, calls }
}

const REQUESTER = { platform: "discord" as const, channel: "c1", user: "u1" }
const OPTIONS = { toolCallId: "t", messages: [], context: {} }

describe("the catalog", () => {
  test("tool names carry the service and fit the API's limit", () => {
    expect(toolName("dorothy", "list_sites")).toBe("dorothy_list_sites")
    expect(toolName("posthog", "query.run")).toBe("posthog_query_run")
    expect(toolName("posthog", "x".repeat(80))).toHaveLength(64)
  })

  test("the model reads what the ready services do and which are left to connect", () => {
    const text = servicesInstructions(CATALOG.services)
    expect(text).toContain("- Dorothy, tools `dorothy_*`")
    expect(text).toContain("Not connected yet: Cloudflare.")
    expect(text).not.toContain("Not connected yet: Dorothy")
  })

  test("every service has a URL; Dorothy's key comes from its secret", () => {
    for (const spec of SERVICES) expect(spec.url({})).toStartWith("https://")
    const dorothy = SERVICES.find((spec) => spec.id === "dorothy")
    expect(dorothy?.key({})).toBeUndefined()
    expect(dorothy?.key({ DOROTHY_API_KEY: "k" })).toEqual({ "x-api-key": "k" })
  })
})

describe("the agent's tools", () => {
  test("a remote tool calls the service by its own name", async () => {
    const { port, calls } = fakePort()
    const tools = servicesTools(port, CATALOG, REQUESTER)
    expect(Object.keys(tools)).toEqual(["dorothy_get_site", "connect_service"])
    expect(await tools.dorothy_get_site?.execute?.({ site_id: "a" }, OPTIONS)).toBe("site a")
    expect(calls[0]).toEqual(["dorothy", "get_site", { site_id: "a" }])
  })

  test("an error from the service fails the call with its message", () => {
    const { port } = fakePort()
    const tools = servicesTools(port, CATALOG, REQUESTER)
    expect(tools.dorothy_get_site?.execute?.({ site_id: "gone" }, OPTIONS)).rejects.toThrow(
      "site not found",
    )
  })

  test("connect_service hands out the link and says where to announce it", async () => {
    const { port, calls } = fakePort()
    const tools = servicesTools(port, CATALOG, REQUESTER)
    expect(await tools.connect_service?.execute?.({ service: "posthog" }, OPTIONS)).toEqual({
      link: "https://x",
    })
    expect(calls[0]).toEqual(["authorize", "posthog", REQUESTER])
  })
})

describe("commands", () => {
  const slash = { command: "/bob", user_id: "U1", channel_id: "C1", response_url: "https://r" }

  test("Slack reads connect and disconnect", () => {
    expect(toCommand({ ...slash, text: "connect" })).toEqual({
      name: "connect",
      service: undefined,
      channel: "C1",
      user: "U1",
    })
    expect(toCommand({ ...slash, text: "connect posthog" })).toMatchObject({ service: "posthog" })
    expect(toCommand({ ...slash, text: "disconnect cloudflare" })).toEqual({
      name: "disconnect",
      service: "cloudflare",
    })
    expect(toCommand({ ...slash, text: "disconnect" })).toBeUndefined()
  })

  test("the replies list the services and hand over the link", () => {
    const config = new Config(memoryDatabase())
    const listed = commandReply({ kind: "services", services: CATALOG.services }, config, "slack")
    expect(listed.text).toContain("✅ **Dorothy** connected by key, 1 tool")
    expect(listed.text).toContain("⏳ **Cloudflare** not connected")
    expect(listed.text).toContain("`/bob connect <service>`")
    const link = commandReply(
      { kind: "authorize", result: { kind: "link", service: "posthog", url: "https://auth" } },
      config,
      "discord",
    )
    expect(link.text).toContain("connect PostHog")
    expect(link.text).toEndWith("https://auth")
  })
})

test("a tool line names the service it belongs to", () => {
  const step: Step = { id: "1", tool: "dorothy_list_sites", input: {}, state: "done" }
  expect(stepLine(step)).toBe("✅ Asked Dorothy: `list_sites`")
})
