// Space Grotesk, grace's typeface, bundled into the Worker for the images bob draws.
import regular from "@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff"
import medium from "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff"
import bold from "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff"

import type { Font } from "./render"

export const FONTS: Font[] = [
  { data: regular, weight: 400 },
  { data: medium, weight: 500 },
  { data: bold, weight: 700 },
]
