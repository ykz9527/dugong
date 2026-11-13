import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { normalizeWorkspacePath } from '@hapi/protocol'
import type { StoredWorkspaceUser } from './types'
import { safeJsonParse } from './json'

/**
 * Workspace user storage (schema v28).
 *
 * One row per person sharing a namespace, holding the root directories that
 * mark their work as theirs. Namespace-scoped like everything else a route can
 * reach: two namespaces may both have an "Alice" and they are not the same
 * Alice.
 *
 * `paths` is a JSON array rather than a child table. It is read whole on every
 * request, written whole on every edit, and never joined against - a second
 * table would buy nothing but a join.
 */

type DbWorkspaceUserRow = {
    id: string
    namespace: string
    name: string
    paths: string
    created_at: number
    updated_at: number
}

function toStoredWorkspaceUser(row: DbWorkspaceUserRow): StoredWorkspaceUser {
    const parsed = safeJsonParse(row.paths)
    // A row whose paths no longer parse owns nothing rather than everything:
    // the failure mode of guessing wrong here is showing a person somebody
    // else's work, which is the one thing this feature exists to prevent.
    const paths = Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : []
    return {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        paths,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

/** Drop blanks, normalize, de-duplicate. Order is the operator's, kept as-is. */
function sanitizeWorkspacePaths(paths: readonly string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of paths) {
        const normalized = normalizeWorkspacePath(raw)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        result.push(normalized)
    }
    return result
}

export function listWorkspaceUsers(db: Database, namespace: string): StoredWorkspaceUser[] {
    const rows = db.prepare(
        'SELECT * FROM workspace_users WHERE namespace = ? ORDER BY name COLLATE NOCASE ASC, created_at ASC'
    ).all(namespace) as DbWorkspaceUserRow[]
    return rows.map(toStoredWorkspaceUser)
}

export function getWorkspaceUser(db: Database, id: string, namespace: string): StoredWorkspaceUser | null {
    const row = db.prepare(
        'SELECT * FROM workspace_users WHERE id = ? AND namespace = ? LIMIT 1'
    ).get(id, namespace) as DbWorkspaceUserRow | undefined
    return row ? toStoredWorkspaceUser(row) : null
}

export function createWorkspaceUser(
    db: Database,
    input: { namespace: string; name: string; paths: readonly string[] }
): StoredWorkspaceUser {
    const now = Date.now()
    const row: DbWorkspaceUserRow = {
        id: randomUUID(),
        namespace: input.namespace,
        name: input.name.trim(),
        paths: JSON.stringify(sanitizeWorkspacePaths(input.paths)),
        created_at: now,
        updated_at: now
    }
    db.prepare(`
        INSERT INTO workspace_users (id, namespace, name, paths, created_at, updated_at)
        VALUES (@id, @namespace, @name, @paths, @created_at, @updated_at)
    `).run(row)
    return toStoredWorkspaceUser(row)
}

export function updateWorkspaceUser(
    db: Database,
    id: string,
    namespace: string,
    patch: { name?: string; paths?: readonly string[] }
): StoredWorkspaceUser | null {
    const existing = getWorkspaceUser(db, id, namespace)
    if (!existing) return null

    const name = patch.name === undefined ? existing.name : patch.name.trim()
    const paths = patch.paths === undefined ? existing.paths : sanitizeWorkspacePaths(patch.paths)
    const updatedAt = Date.now()
    db.prepare(`
        UPDATE workspace_users
        SET name = @name, paths = @paths, updated_at = @updated_at
        WHERE id = @id AND namespace = @namespace
    `).run({ id, namespace, name, paths: JSON.stringify(paths), updated_at: updatedAt })

    return { ...existing, name, paths, updatedAt }
}

export function deleteWorkspaceUser(db: Database, id: string, namespace: string): boolean {
    const result = db.prepare(
        'DELETE FROM workspace_users WHERE id = ? AND namespace = ?'
    ).run(id, namespace)
    return result.changes > 0
}
