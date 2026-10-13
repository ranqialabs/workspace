// A view tree as a PNG: satori lays it out as SVG, resvg paints it. Both run
// as WebAssembly in the Worker.
import { Resvg } from "@cf-wasm/resvg"
import { satori } from "@cf-wasm/satori"

import type { Node } from "./retro-image"

export interface Font {
  data: ArrayBuffer
  weight: 400 | 500 | 700
}

/** `width` is fixed; the height follows the content. */
export async function png(node: Node, width: number, fonts: Font[]): Promise<Uint8Array> {
  const svg = await satori(node, {
    width,
    fonts: fonts.map((font) => ({
      name: "Space Grotesk",
      data: font.data,
      weight: font.weight,
      style: "normal",
    })),
  })
  const image = await Resvg.async(svg, { fitTo: { mode: "width", value: width } })
  return image.render().asPng()
}
