/**
 * Git remote URL parsing.
 *
 * Deliberately narrow: SSH config host aliases (which `ssh -G` could resolve
 * to the real forge) are not followed. Until HAPI supports more than one forge
 * there is nothing for that to disambiguate, and a synchronous `ssh -G` per
 * lookup is a real cost. Revisit when GitLab and Bitbucket land.
 */

export type ParsedRemote = {
    /** Hostname as written in the remote (`github.com`, `ghe.corp.example`). */
    host: string
    owner: string
    repo: string
}

/** Trailing `.git`, and any trailing slashes, are not part of the repo name. */
function stripSuffix(value: string): string {
    return value.replace(/\/+$/, '').replace(/\.git$/i, '')
}

function splitOwnerRepo(path: string): { owner: string; repo: string } | null {
    const segments = stripSuffix(path).split('/').filter(Boolean)
    if (segments.length < 2) return null
    // GitLab-style nested groups keep everything but the last segment as the
    // owner, which is also what GitHub expects for `owner/repo`.
    const repo = segments[segments.length - 1]
    const owner = segments.slice(0, -1).join('/')
    if (!owner || !repo) return null
    return { owner, repo }
}

/**
 * Parse the three remote spellings git itself accepts:
 *   https://host/owner/repo.git
 *   ssh://git@host[:port]/owner/repo.git
 *   git@host:owner/repo.git          (scp-like, no scheme)
 *
 * Returns null for anything else — a local path remote, a malformed URL, or a
 * remote with no owner segment.
 */
export function parseGitRemote(remote: string): ParsedRemote | null {
    const trimmed = remote.trim()
    if (!trimmed) return null

    // scp-like syntax has no scheme and a colon that is not a port separator.
    const scpMatch = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed)
    if (scpMatch) {
        const host = scpMatch[2].toLowerCase()
        const parts = splitOwnerRepo(scpMatch[3])
        return parts ? { host, ...parts } : null
    }

    try {
        const url = new URL(trimmed)
        if (!url.hostname) return null
        const parts = splitOwnerRepo(url.pathname)
        return parts ? { host: url.hostname.toLowerCase(), ...parts } : null
    } catch {
        return null
    }
}
