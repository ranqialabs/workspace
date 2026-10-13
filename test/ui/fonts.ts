// The fonts the Worker bundles, read from disk for tests.
import type { Font } from "../../src/ui/render"

const DIR = "node_modules/@fontsource/space-grotesk/files"

export async function testFonts(): Promise<Font[]> {
  const weights = [400, 500, 700] as const
  return Promise.all(
    weights.map(async (weight) => ({
      weight,
      data: await Bun.file(`${DIR}/space-grotesk-latin-${weight}-normal.woff`).arrayBuffer(),
    })),
  )
}
