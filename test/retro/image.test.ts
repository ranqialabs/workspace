import { expect, test } from "bun:test"

import { png } from "../../src/ui/render"
import { type Face, retroImage, WIDTH } from "../../src/ui/retro-image"
import type { Summary } from "../../src/retro/summary"
import { testFonts } from "../ui/fonts"
import { SAMPLE } from "./sample"

const faces = new Map<string, Face>([
  ["felipeadeildo", { login: "felipeadeildo", name: "Adeildo" }],
  ["itsmeale", { login: "itsmeale", name: "Alê" }],
])

test("the retro renders as a PNG", async () => {
  const image = await png(retroImage(SAMPLE, faces), WIDTH, await testFonts())
  // PNG's signature.
  expect(Array.from(image.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  if (process.env.RETRO_PREVIEW) await Bun.write(process.env.RETRO_PREVIEW, image)
})

test("the retro renders with the model's summary on top", async () => {
  const summary: Summary = {
    overview:
      "bob moved to Cloudflare Workers and now answers on Discord and Slack; signing in survives a password reset, and Aurora's master password rotates on its own.",
    themes: [
      {
        title: "bob on Cloudflare Workers",
        meaning:
          "The bot runs on Workers and talks on Discord and Slack, so one deploy covers both chats.",
        pulls: SAMPLE.merged.filter((pull) => pull.number === 32),
      },
      {
        title: "Sessions survive a reset",
        meaning:
          "People stay signed in after changing their password instead of being sent back to login.",
        pulls: SAMPLE.merged.filter((pull) => pull.number === 118),
      },
      {
        title: "Aurora password managed by AWS",
        meaning:
          "The database master password now rotates in Secrets Manager; nobody keeps a copy.",
        pulls: SAMPLE.merged.filter((pull) => pull.number === 87 || pull.number === 41),
      },
    ],
  }
  const image = await png(retroImage(SAMPLE, faces, summary), WIDTH, await testFonts())
  expect(image.length).toBeGreaterThan(1000)
  if (process.env.RETRO_SUMMARY_PREVIEW) await Bun.write(process.env.RETRO_SUMMARY_PREVIEW, image)
})

test("a quiet day still renders", async () => {
  const quiet = { ...SAMPLE, merged: [], reviewed: {}, open: [] }
  const image = await png(retroImage(quiet, faces), WIDTH, await testFonts())
  expect(image.length).toBeGreaterThan(1000)
})
