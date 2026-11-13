import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createPermissionsRoutes } from './permissions'

const JWT_SECRET = new TextEncoder().encode('test-secret')

type Approval = { sessionId: string; allowTools?: string[]; decision?: string }

let sessions: Map<string, Session>
let approvals: Approval[]
let grants: Array<{ workspaceUserId: string; tools: string[] }>
let app: Hono<WebAppEnv>

async function headers() {
    const token = await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function addSession(id: string, metadata: Record<string, unknown>, request: { tool: string; arguments: unknown }) {
    sessions.set(id, {
        id,
        namespace: 'default',
        active: true,
        metadata,
        agentState: { requests: { 'req-1': request } }
    } as unknown as Session)
}

beforeEach(() => {
    sessions = new Map()
    approvals = []
    grants = []
    const engine = {
        resolveSessionAccess: (id: string, namespace: string) => {
            const session = sessions.get(id)
            if (!session) return { ok: false, reason: 'not-found' }
            if (session.namespace !== namespace) return { ok: false, reason: 'access-denied' }
            return { ok: true, sessionId: id, session }
        },
        approvePermission: async (
            sessionId: string,
            _requestId: string,
            _mode?: string,
            allowTools?: string[],
            decision?: string
        ) => {
            approvals.push({ sessionId, allowTools, decision })
        }
    } as unknown as SyncEngine
    app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createPermissionsRoutes(() => engine, (_namespace, workspaceUserId, _sessionId, tools) => {
        grants.push({ workspaceUserId, tools })
    }))
})

const approve = async (sessionId: string, body: Record<string, unknown>) =>
    app.request(`/api/sessions/${sessionId}/permissions/req-1/approve`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body)
    })

describe('permission approval on a task assistant session', () => {
    it('records "allow for session" from Claude as a standing grant', async () => {
        addSession('claude-assistant', { path: '/a', host: 'h', role: 'assistant', workspaceUserId: 'alice' }, {
            tool: 'mcp__hapi__ping_peer', arguments: {}
        })

        const res = await approve('claude-assistant', { allowTools: ['mcp__hapi__ping_peer', 'Bash(ls)'] })

        expect(res.status).toBe(200)
        expect(grants).toEqual([{ workspaceUserId: 'alice', tools: ['mcp__hapi__ping_peer'] }])
        expect(approvals[0]?.allowTools).toEqual(['Bash(ls)'])
    })

    it('records "yes, for session" from Codex as a standing grant and passes on a plain yes', async () => {
        addSession('codex-assistant', { path: '/a', host: 'h', flavor: 'codex', role: 'assistant', workspaceUserId: 'alice' }, {
            tool: 'task_start', arguments: { serverName: 'hapi', message: 'Allow?' }
        })

        const res = await approve('codex-assistant', { decision: 'approved_for_session' })

        expect(res.status).toBe(200)
        expect(grants).toEqual([{ workspaceUserId: 'alice', tools: ['mcp__hapi__task_start'] }])
        expect(approvals[0]?.decision).toBe('approved')
    })

    it('records nothing for a tool that is not grantable, or a session that is not an assistant', async () => {
        addSession('codex-assistant', { path: '/a', host: 'h', flavor: 'codex', role: 'assistant', workspaceUserId: 'alice' }, {
            tool: 'memory_read', arguments: { serverName: 'hapi' }
        })
        addSession('codex-task', { path: '/a', host: 'h', flavor: 'codex' }, {
            tool: 'task_start', arguments: { serverName: 'hapi' }
        })

        await approve('codex-assistant', { decision: 'approved_for_session' })
        await approve('codex-task', { decision: 'approved_for_session' })

        expect(grants).toEqual([])
        expect(approvals.map((a) => a.decision)).toEqual(['approved_for_session', 'approved_for_session'])
    })

    it('never records peer_respond, and never lets it through for the session', async () => {
        addSession('claude-assistant', { path: '/a', host: 'h', role: 'assistant', workspaceUserId: 'alice' }, {
            tool: 'mcp__hapi__peer_respond', arguments: {}
        })
        addSession('codex-assistant', { path: '/a', host: 'h', flavor: 'codex', role: 'assistant', workspaceUserId: 'alice' }, {
            tool: 'peer_respond', arguments: { serverName: 'hapi' }
        })

        await approve('claude-assistant', { allowTools: ['mcp__hapi__peer_respond'] })
        await approve('codex-assistant', { decision: 'approved_for_session' })

        expect(grants).toEqual([])
        expect(approvals[0]?.allowTools).toEqual([])
        expect(approvals[1]?.decision).toBe('approved')
    })
})
