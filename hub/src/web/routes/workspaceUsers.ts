import {
    CreateWorkspaceUserRequestSchema,
    UpdateWorkspaceUserRequestSchema,
    type WorkspaceUser,
    type WorkspaceUserListResponse,
    type WorkspaceUserResponse
} from '@hapi/protocol'
import { Hono } from 'hono'
import type { Store, StoredWorkspaceUser } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

/**
 * Workspace users: who works out of which directories.
 *
 * A view-scoping list, not an account system — there is no login here and no
 * password. Anyone already authenticated into the namespace may read and edit
 * the whole list, because the point is to let a shared hub say "these cards
 * are Kai's, those are Ming's", not to keep the two apart by force.
 */

function toWorkspaceUser(row: StoredWorkspaceUser): WorkspaceUser {
    return {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        paths: row.paths,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }
}

export function createWorkspaceUserRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/workspace-users', (c) => {
        const rows = store.workspaceUsers.list(c.get('namespace'))
        const response: WorkspaceUserListResponse = { workspaceUsers: rows.map(toWorkspaceUser) }
        return c.json(response)
    })

    app.post('/workspace-users', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = CreateWorkspaceUserRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }

        const row = store.workspaceUsers.create({
            namespace: c.get('namespace'),
            name: parsed.data.name,
            paths: parsed.data.paths
        })
        const response: WorkspaceUserResponse = { workspaceUser: toWorkspaceUser(row) }
        return c.json(response, 201)
    })

    app.patch('/workspace-users/:id', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = UpdateWorkspaceUserRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
        }

        const row = store.workspaceUsers.update(
            c.req.param('id') ?? '',
            c.get('namespace'),
            parsed.data
        )
        if (!row) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        const response: WorkspaceUserResponse = { workspaceUser: toWorkspaceUser(row) }
        return c.json(response)
    })

    app.delete('/workspace-users/:id', (c) => {
        const removed = store.workspaceUsers.delete(c.req.param('id') ?? '', c.get('namespace'))
        if (!removed) {
            return c.json({ error: 'Workspace user not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}
