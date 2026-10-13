import { expect, test } from "bun:test"

import { png } from "../../src/ui/render"
import { type Face, retroImage, WIDTH } from "../../src/ui/retro-image"
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

test("a quiet day still renders", async () => {
  const quiet = { ...SAMPLE, merged: [], reviewed: {}, open: [] }
  const image = await png(retroImage(quiet, faces), WIDTH, await testFonts())
  expect(image.length).toBeGreaterThan(1000)
})
