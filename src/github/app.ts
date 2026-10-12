// bob acts on GitHub as the app's installation on the org. Octokit re-mints the
// installation token as it expires, so one client serves a Durable Object's life.
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"

import { toPkcs8 } from "./key"

export type GitHub = Octokit

export interface AppCredentials {
  appId: string
  privateKey: string
  org: string
}

export function credentials(env: Env): AppCredentials {
  return { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, org: env.GITHUB_ORG }
}

export async function installationClient(app: AppCredentials): Promise<GitHub> {
  const auth = { appId: app.appId, privateKey: toPkcs8(app.privateKey) }
  const asApp = new Octokit({ authStrategy: createAppAuth, auth })
  const { data } = await asApp.rest.apps.getOrgInstallation({ org: app.org })
  return new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId: data.id } })
}
