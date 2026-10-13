import { expect, test } from "bun:test"

import type { Attachment } from "../src/chat/chat"
import { DiscordChat } from "../src/discord/messages"
import { DiscordRest } from "../src/discord/rest"
import { SlackApi } from "../src/slack/api"
import { SlackChat } from "../src/slack/chat"
import type { Card } from "../src/ui/card"

const file: Attachment = { name: "retro.png", data: new Uint8Array([1, 2, 3]), alt: "The day" }
const card: Card = { tone: "brand", kicker: "📊 Daily retro", title: "Monday", image: "retro.png" }

test("Discord sends the image as multipart and the embed shows it by name", async () => {
  const sent: Request[] = []
  const rest = new DiscordRest("t", (request) => {
    sent.push(request)
    return Promise.resolve(Response.json({ id: "m1" }))
  })
  await new DiscordChat(rest).post("c1", { cards: [card], attachment: file })
  const form = await sent[0]?.formData()
  const json = form?.get("payload_json")
  const payload = JSON.parse(typeof json === "string" ? json : "{}")
  expect(payload.embeds[0].image).toEqual({ url: "attachment://retro.png" })
  expect(payload.attachments).toEqual([{ id: 0, filename: "retro.png", description: "The day" }])
  const upload = form?.get("files[0]")
  expect(upload instanceof Blob ? upload.size : 0).toBe(3)
})

test("Slack posts the card, then uploads the image to the same thread", async () => {
  const calls: string[] = []
  const api = new SlackApi("xoxb", async (request) => {
    const url = new URL(request.url)
    calls.push(url.hostname === "files.example" ? "upload" : (url.pathname.split("/").at(-1) ?? ""))
    if (url.pathname.endsWith("chat.postMessage"))
      return Response.json({ ok: true, ts: "1.0", channel: "C1" })
    if (url.pathname.endsWith("files.getUploadURLExternal")) {
      return Response.json({ ok: true, upload_url: "https://files.example/up", file_id: "F1" })
    }
    if (url.hostname === "files.example") return new Response("OK")
    const body = new URLSearchParams(await request.text())
    expect(JSON.parse(body.get("files") ?? "[]")).toEqual([{ id: "F1", title: "The day" }])
    expect(body.get("channel_id")).toBe("C1")
    return Response.json({ ok: true })
  })
  await new SlackChat(api).post("C1", { cards: [card], attachment: file })
  expect(calls).toEqual([
    "chat.postMessage",
    "files.getUploadURLExternal",
    "upload",
    "files.completeUploadExternal",
  ])
})
