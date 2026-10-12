// The trust boundary for everything GitHub sends: a delivery is read only once
// its signature checks out against the secret shared with the app.

export async function signatureMatches(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  const hex = header?.startsWith("sha256=") === true ? header.slice(7) : undefined
  if (hex === undefined || !/^[0-9a-f]{64}$/.test(hex)) return false
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  )
  // verify() compares in constant time, which a string comparison would not.
  return crypto.subtle.verify("HMAC", key, Uint8Array.fromHex(hex), new TextEncoder().encode(body))
}

export interface Delivery {
  id: string
  event: string
  payload: unknown
}

export async function readDelivery(request: Request, secret: string): Promise<Delivery | Response> {
  const body = await request.text()
  if (!(await signatureMatches(secret, body, request.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 })
  }
  const payload: unknown = JSON.parse(body)
  return {
    id: request.headers.get("x-github-delivery") ?? "",
    event: request.headers.get("x-github-event") ?? "",
    payload,
  }
}
