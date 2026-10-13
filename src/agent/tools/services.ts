// The outside services' tools as the model sees them. They run in the Services
// object; here each becomes a tool that calls it by name.
import { type JSONSchema7, jsonSchema, tool, type ToolSet } from "ai"
import { z } from "zod"

import {
  type AuthorizeResult,
  type CallResult,
  type Catalog,
  type Requester,
  SERVICES,
  type ServiceId,
  toolName,
} from "../../services/catalog"

export interface ServicesPort {
  catalog(): Promise<Catalog>
  call(service: ServiceId, tool: string, args: Record<string, unknown>): Promise<CallResult>
  authorize(name: string, requester?: Requester): Promise<AuthorizeResult>
}

const OAUTH = SERVICES.filter((spec) => spec.oauth).map((spec) => spec.id)

export function servicesTools(port: ServicesPort, catalog: Catalog, requester: Requester): ToolSet {
  const tools: ToolSet = {}
  for (const remote of catalog.tools) {
    const schema: JSONSchema7 = JSON.parse(remote.inputSchema)
    tools[toolName(remote.service, remote.name)] = tool({
      description: remote.description,
      inputSchema: jsonSchema(schema),
      execute: async (args) => {
        const input =
          typeof args === "object" && args !== null ? Object.fromEntries(Object.entries(args)) : {}
        const result = await port.call(remote.service, remote.name, input)
        // A failed call throws, so the progress card shows it as failed.
        if (!result.ok) throw new Error(result.text || "the service reported an error")
        return result.text
      },
    })
  }
  tools.connect_service = tool({
    description:
      "The link that lets someone authorize bob on a service. Give it to them as is; once they authorize, bob says so in this channel.",
    inputSchema: z.object({ service: z.enum(OAUTH) }),
    execute: async ({ service }) => {
      const result = await port.authorize(service, requester)
      switch (result.kind) {
        case "link":
          return { link: result.url }
        case "ready":
          return { connected: true, tools: result.tools }
        case "keyed":
          return { connected: true, note: "A secret key connects it; nothing to authorize." }
        case "failed":
          throw new Error(result.error)
        case "unknown":
          throw new Error(`No service called ${result.name}.`)
        default:
          return result satisfies never
      }
    },
  })
  return tools
}
