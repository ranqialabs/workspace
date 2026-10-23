// A view tree as a PNG: satori lays it out as SVG, resvg paints it. Both run
// as WebAssembly in the Worker.
import { Resvg } from "@cf-wasm/resvg"
import { satori } from "@cf-wasm/satori"

import type { Node } from "./tree"

export interface Font {
  data: ArrayBuffer
  weight: 400 | 500 | 700
}

/**
 * `width` is fixed; the height follows the content. A `maxHeight` refuses the
 * picture before resvg sees it, since a tall one can panic the WASM renderer.
 */
export async function png(
  node: Node,
  width: number,
  fonts: Font[],
  maxHeight?: number,
): Promise<Uint8Array> {
  const svg = await satori(node, {
    width,
    fonts: fonts.map((font) => ({
      name: "Space Grotesk",
      data: font.data,
      weight: font.weight,
      style: "normal",
    })),
  })
  if (maxHeight !== undefined) {
    const height = Number(/<svg[^>]*height="([^"]+)"/.exec(svg)?.[1])
    if (Number.isFinite(height) && height > maxHeight) {
      throw new Error(`the picture is ${height}px tall, over ${maxHeight}px`)
    }
  }
  const image = await Resvg.async(svg, { fitTo: { mode: "width", value: width } })
  return image.render().asPng()
}
