// Who appears in the retro image: the name bob knows and the GitHub avatar,
// fetched small and inlined, since satori draws only what it is handed.
import type { Person } from "../store/config"
import type { Face } from "../ui/retro-image"

const AVATAR_PX = 96
const TIMEOUT_MS = 3000

type Fetch = (request: Request) => Promise<Response>

/** A face per login; one whose avatar fails to load keeps its initial. */
export async function faces(
  logins: string[],
  people: Person[],
  fetcher: Fetch = (request) => fetch(request),
): Promise<Map<string, Face>> {
  const entries = await Promise.all(
    logins.map(async (login) => {
      const person = people.find(
        (candidate) => candidate.github?.toLowerCase() === login.toLowerCase(),
      )
      const face: Face = {
        login,
        name: person?.name ?? login,
        avatar: await avatar(login, fetcher),
      }
      return [login, face] as const
    }),
  )
  return new Map(entries)
}

async function avatar(login: string, fetcher: Fetch): Promise<string | undefined> {
  const url = `https://github.com/${encodeURIComponent(login)}.png?size=${AVATAR_PX}`
  try {
    const response = await fetcher(new Request(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }))
    if (!response.ok) return undefined
    const type = response.headers.get("content-type") ?? "image/png"
    if (!type.startsWith("image/")) return undefined
    const bytes = new Uint8Array(await response.arrayBuffer())
    return `data:${type};base64,${bytes.toBase64()}`
  } catch {
    return undefined
  }
}
