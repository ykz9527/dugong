import {
    assistantRequestToolId,
    isAssistantAlwaysAskTool,
    isAssistantGrantableTool,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import { PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const decisionSchema = z.enum(['approved', 'approved_for_session', 'denied', 'abort'])

// Flat format: Record<string, string[]> (AskUserQuestion)
// Nested format: Record<string, { answers: string[] }> (request_user_input)
const answersSchema = z.union([
    z.record(z.string(), z.array(z.string())),
    z.record(z.string(), z.object({ answers: z.array(z.string()) }))
])

const approveBodySchema = z.object({
    mode: PermissionModeSchema.optional(),
    allowTools: z.array(z.string()).optional(),
    decision: decisionSchema.optional(),
    answers: answersSchema.optional()
})

const denyBodySchema = z.object({
    decision: decisionSchema.optional()
})

export function createPermissionsRoutes(
    getSyncEngine: () => SyncEngine | null,
    /**
     * A task assistant's session never ends, so "allow for this session" on
     * one of its grantable tools means "from now on". Those are recorded as
     * standing grants -- visible and revocable -- instead of being cached in
     * the CLI where revoking could not reach them.
     */
    /** Records standing grants for an assistant's tools. The caller checks
     *  that `sessionId` really is that person's assistant in this namespace:
     *  the session's metadata is reported by the CLI and can't be trusted. */
    grantAssistantTools?: (namespace: string, workspaceUserId: string, sessionId: string, tools: string[]) => void
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/permissions/:requestId/approve', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const json = await c.req.json().catch(() => null)
        const parsed = approveBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const request = session.agentState?.requests?.[requestId]
        if (!request) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const mode = parsed.data.mode
        if (mode !== undefined) {
            const flavor = session.metadata?.flavor ?? 'claude'
            if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
        }
        let allowTools = parsed.data.allowTools
        let decision = parsed.data.decision
        const metadata = session.metadata
        if (metadata?.role === 'assistant') {
            // Neither a grant nor a session cache for the assistant's
            // confirm-first tools: grantable ones become standing grants
            // (visible, revocable), always-ask ones get a one-off yes.
            const remembered = (tool: string) => isAssistantGrantableTool(tool) || isAssistantAlwaysAskTool(tool)
            const grants = (allowTools ?? []).filter(isAssistantGrantableTool)
            allowTools = allowTools?.filter((tool) => !remembered(tool))
            // Codex says "yes, for session" as a decision rather than a tool
            // list; pass it on as a plain yes so Codex keeps no session
            // approval of its own where revoking cannot reach it.
            const requestTool = assistantRequestToolId(request.tool, request.arguments)
            if (decision === 'approved_for_session' && requestTool && remembered(requestTool)) {
                if (isAssistantGrantableTool(requestTool)) grants.push(requestTool)
                decision = 'approved'
            }
            if (grants.length > 0 && metadata.workspaceUserId && grantAssistantTools) {
                grantAssistantTools(c.get('namespace'), metadata.workspaceUserId, sessionId, grants)
            }
        }
        const answers = parsed.data.answers
        await engine.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/permissions/:requestId/deny', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            return c.json({ error: 'Request not found' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = denyBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.denyPermission(sessionId, requestId, parsed.data.decision)
        return c.json({ ok: true })
    })

    return app
}
