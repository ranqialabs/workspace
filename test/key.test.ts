import { expect, test } from "bun:test"
import { createPrivateKey, generateKeyPairSync } from "node:crypto"

import { toPkcs8 } from "../src/github/key"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" })
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" })

test("a PKCS#1 key comes out as the same key in PKCS#8", () => {
  expect(toPkcs8(pkcs1)).toBe(pkcs8.trim())
  expect(createPrivateKey(toPkcs8(pkcs1)).asymmetricKeyType).toBe("rsa")
})

test("WebCrypto imports the wrapped key", async () => {
  const der = Uint8Array.fromBase64(
    toPkcs8(pkcs1)
      .replaceAll(/-----[A-Z ]+-----/g, "")
      .replaceAll(/\s/g, ""),
  )
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  expect(key.type).toBe("private")
})

test("a PKCS#8 key passes through", () => {
  expect(toPkcs8(pkcs8)).toBe(pkcs8.trim())
})

test("escaped newlines from a one-line secret are restored", () => {
  expect(toPkcs8(pkcs1.replaceAll("\n", "\\n"))).toBe(pkcs8.trim())
})

test("anything else is refused by name", () => {
  expect(() => toPkcs8("ssh-rsa AAAA")).toThrow("GITHUB_APP_PRIVATE_KEY")
})
