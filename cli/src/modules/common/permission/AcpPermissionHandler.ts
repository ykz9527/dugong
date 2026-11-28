import { randomUUID } from 'node:crypto'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from './BasePermissionHandler'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    reason?: string
}

function deriveToolInput(request: PermissionRequest): unknown {
    return request.rawInput !== undefined ? request.rawInput : request.rawOutput
}

function pickOptionId(request: PermissionRequest, preferredKinds: string[]): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind)
        if (match) return match.optionId
    }
    return request.options[0]?.optionId ?? null
}

function mapDecisionToOutcome(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision']
): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' }
    if (decision === 'approved_for_session') {
        const optionId = pickOptionId(request, ['allow_always', 'allow_once'])
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    if (decision === 'approved') {
        const optionId = pickOptionId(request, ['allow_once', 'allow_always'])
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    const optionId = pickOptionId(request, ['reject_once', 'reject_always'])
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
}

/** Identity of a request for "allow for this session": same kind and same
 *  derived name (ACP titles carry the command line or the target path). */
function sessionApprovalKey(request: PermissionRequest, toolName: string): string {
    return `${request.kind ?? ''}\u0000${toolName}`
}

/**
 * The hub tool an ACP request is for, when it is one: agy titles MCP calls
 * `mcp_<server>_<tool>` ("Run mcp_hapi_ping_peer").
 */
export function hapiToolOfAcpRequest(request: Pick<PermissionRequest, 'title'>, toolName: string): string | null {
    const match = /\bmcp_hapi_([a-z_]+)/.exec(`${request.title ?? ''} ${toolName}`)
    return match ? match[1] : null
}

/** Hub tools that show the person a local file; they still ask under the assistant. */
const ASKING_HAPI_TOOLS = new Set(['display_media', 'display_video'])

/** Requests raised by `askHapiTool` carry this tool-name prefix. */
const HAPI_TOOL_ID_PREFIX = 'mcp__hapi__'

/** Shared HAPI permission bridge for ACP agents with one-shot choices. */
export class AcpPermissionHandler extends BasePermissionHandler<PermissionResponseMessage, PermissionCompletion> {
    private readonly pendingBackendRequests = new Map<string, PermissionRequest>()
    /** "Allow for session" grants HAPI keeps itself, for agents (such as agy)
     *  that offer no `allow_always` option of their own. */
    private readonly sessionApprovals = new Set<string>()

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => PermissionMode | undefined,
        /**
         * Task assistant: hub tools are let through here, because the
         * confirm-first ones ask in the MCP server (`askHapiTool`) instead.
         */
        private readonly options: { assistant?: boolean } = {}
    ) {
        super(session)
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request))
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        })
        const toolInput = deriveToolInput(request)
        const hapiTool = this.options.assistant ? hapiToolOfAcpRequest(request, toolName) : null
        if (hapiTool && !ASKING_HAPI_TOOLS.has(hapiTool)) {
            void this.autoApprove(request, toolName, toolInput, 'approved')
            return
        }
        const autoDecision = this.resolveAutoApprovalDecision(
            this.getPermissionMode(),
            toolName,
            request.toolCallId
        ) ?? (this.sessionApprovals.has(sessionApprovalKey(request, toolName)) ? 'approved_for_session' : null)
        if (autoDecision) {
            void this.autoApprove(request, toolName, toolInput, autoDecision)
            return
        }

        this.pendingBackendRequests.set(request.id, request)
        this.addPendingRequest(request.id, toolName, toolInput, {
            resolve: () => {},
            reject: () => {}
        })
        logger.debug(`[ACP] Permission request queued for ${toolName} (${request.id})`)
    }

    /**
     * Ask the person about a hub tool (`mcp__hapi__<name>`) the agent is
     * calling. Settles with their answer; rejects when it is canceled. Outlives
     * the turn that asked: only an abort or the session's end cancels it.
     */
    askHapiTool(toolId: string, input: unknown): Promise<PermissionCompletion> {
        return new Promise((resolve, reject) => {
            this.addPendingRequest(randomUUID(), toolId, input, { resolve, reject })
        })
    }

    private async autoApprove(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown,
        decision: AutoApprovalDecision
    ): Promise<void> {
        await this.backend.respondToPermission(request.sessionId, request, mapDecisionToOutcome(request, decision))
        const timestamp = Date.now()
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        }))
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<PermissionCompletion>
    ): Promise<PermissionCompletion> {
        const request = this.pendingBackendRequests.get(response.id)
        this.pendingBackendRequests.delete(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')

        const completion: PermissionCompletion = {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason
        }

        if (decision === 'approved_for_session' && request
            && !request.options.some((option) => option.kind === 'allow_always')) {
            this.sessionApprovals.add(sessionApprovalKey(request, pending.toolName))
        }
        // Record the decision before answering the agent: a turn that ends right
        // after the answer runs cancelAll('Prompt finished'), which would
        // otherwise mark this still-listed request as canceled.
        this.finalizeRequest(response.id, completion)
        if (decision === 'abort' && request) {
            await this.backend.cancelPrompt(request.sessionId)
        }
        if (request) {
            await this.backend.respondToPermission(request.sessionId, request, mapDecisionToOutcome(request, decision))
        }
        pending.resolve(completion)

        return completion
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[ACP] Permission response received for unknown request', response.id)
    }

    /**
     * `keepHapiAsks`: leave `askHapiTool` requests standing, for the end of a
     * turn; the person may answer them long after it.
     */
    async cancelAll(reason: string, options: { keepHapiAsks?: boolean } = {}): Promise<void> {
        const pending = Array.from(this.pendingBackendRequests.values())
        this.pendingBackendRequests.clear()
        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
        }
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort',
            ...(options.keepHapiAsks ? { filter: (toolName: string) => !toolName.startsWith(HAPI_TOOL_ID_PREFIX) } : {})
        })
    }
}
