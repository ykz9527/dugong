import { parseGitRemote } from './parseRemote'
import type { GitHostResult, GitHostTarget } from './types'

export { parseGitRemote } from './parseRemote'
export type {
    CreatePullInput,
    GitHostFailure,
    GitHostKind,
    GitHostResult,
    GitHostTarget,
    PullSnapshot
} from './types'
export { createPull, findPullByHead, getPull, getDefaultBranch, rollUpChecks } from './github'

/**
 * The namespace that owns the hub's git host tokens. The tokens are global
 * (they can reach every repo the owner can), so managing them and every forge
 * call made with them are limited to this namespace.
 */
export const GIT_HOST_OWNER_NAMESPACE = 'default'

export function isGitHostOwner(namespace: string): boolean {
    return namespace === GIT_HOST_OWNER_NAMESPACE
}

/**
 * Forges HAPI knows about but does not implement yet. Named explicitly so a
 * GitLab user gets "not supported" instead of having their host silently
 * treated as a GitHub Enterprise install and every call 404ing.
 */
const KNOWN_UNSUPPORTED_HOSTS = new Set(['gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitea.com'])

/**
 * Work out which API to talk to for a remote.
 *
 * `github.com` is the one host recognised without configuration. Any other
 * host is treated as a GitHub Enterprise install *only* if a token has been
 * configured for it — that configuration is the operator asserting what the
 * host is, which beats guessing from the hostname.
 */
export function resolveGitHostTarget(
    remoteUrl: string,
    tokens: Record<string, string> | undefined
): GitHostResult<GitHostTarget> {
    const parsed = parseGitRemote(remoteUrl)
    if (!parsed) {
        return { outcome: 'rejected', message: `Could not parse git remote: ${remoteUrl}` }
    }

    if (KNOWN_UNSUPPORTED_HOSTS.has(parsed.host)) {
        return { outcome: 'unsupported-host', host: parsed.host }
    }

    const token = tokens?.[parsed.host]
    if (!token) {
        // For github.com this is a plain missing-token; for anything else it is
        // also the reason we cannot tell what the host is.
        return parsed.host === 'github.com'
            ? { outcome: 'no-token', host: parsed.host }
            : { outcome: 'unsupported-host', host: parsed.host }
    }

    const apiBase = parsed.host === 'github.com'
        ? 'https://api.github.com'
        : `https://${parsed.host}/api/v3`

    return {
        outcome: 'ok',
        value: {
            kind: 'github',
            apiBase,
            host: parsed.host,
            owner: parsed.owner,
            repo: parsed.repo,
            token
        }
    }
}
