// GitHub hands out app keys as PKCS#1 and WebCrypto only imports PKCS#8, so the
// key is wrapped here instead of asking whoever deploys to run openssl first.

const PKCS1 = /-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/
const PKCS8 = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/

// AlgorithmIdentifier { rsaEncryption, NULL }
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]

/** The key as PKCS#8 PEM, whichever of the two formats GitHub's key came in. */
export function toPkcs8(pem: string): string {
  const normalized = pem.replaceAll("\\n", "\n").trim()
  if (PKCS8.test(normalized)) return normalized
  const body = PKCS1.exec(normalized)?.[1]
  if (body === undefined) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is neither a PKCS#1 nor a PKCS#8 PEM key")
  }
  const rsa = Uint8Array.fromBase64(body.replaceAll(/\s/g, ""))
  const der = sequence([0x02, 0x01, 0x00], RSA_ALGORITHM, [0x04, ...length(rsa.length), ...rsa])
  const lines = der.toBase64().match(/.{1,64}/g) ?? []
  return ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----"].join("\n")
}

function sequence(...parts: number[][]): Uint8Array {
  const content = parts.flat()
  return new Uint8Array([0x30, ...length(content.length), ...content])
}

function length(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return [0x80 | bytes.length, ...bytes]
}
