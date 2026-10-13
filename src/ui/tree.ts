// A view tree in the shape satori lays out: elements with inline styles. Views
// that become images build it; nothing here draws, so a test can read it.

export interface Node {
  type: string
  props: {
    style?: Record<string, string | number>
    children?: (Node | string)[] | string
    src?: string
  }
}

export function h(
  type: string,
  style: Record<string, string | number>,
  ...children: (Node | string)[]
): Node {
  return { type, props: { style: { display: "flex", ...style }, children } }
}
