import { isAssistantAlwaysAskTool, toAssistantToolId } from '@hapi/protocol'
import type { PermissionCompletion } from '@/modules/common/permission/BasePermissionHandler'
import type { ConfirmToolGate, HapiToolResult } from '@/claude/utils/startHappyServer'
import { logger } from '@/ui/logger'

/**
 * Confirm-first assistant tools under agy.
 *
 * agy only asks before a tool call when its own shared settings say so, and
 * those belong to everyone on the account, so the hub tools that act on other
 * work ask the person here, in the tool itself. agy gives an MCP call three
 * minutes; an assistant is often unattended. So the call waits a while for
 * the answer, and when none comes it returns at once and the outcome reaches
 * agy later as a message of its own.
 */

/** Under agy's 3-minute MCP call limit, with room for the tool to run. */
export const CONFIRM_HOLD_MS = 150_000

export type AssistantToolGateDeps = {
    /** Whether the session lets everything through (agy's always-proceed). */
    isAlwaysProceed: () => boolean
    hasGrant: (toolId: string) => Promise<boolean>
    /** Put an approval card in front of the person; settles with their answer. */
    ask: (toolId: string, input: unknown) => Promise<PermissionCompletion>
    /** Send the agent a message after the call that asked has returned. */
    deliver: (text: string) => void
    holdMs?: number
}

function text(value: string, isError = false): HapiToolResult {
    return { content: [{ type: 'text', text: value }], isError }
}

function resultText(result: HapiToolResult): string {
    return result.content.map((part) => part.text).join('\n')
}

function refusal(name: string, completion: PermissionCompletion): string {
    const reason = completion.reason ? ` Their reason: ${completion.reason}` : ''
    return `The person declined ${name}.${reason} Do not retry it unless they ask.`
}

export function createAssistantToolGate(deps: AssistantToolGateDeps): ConfirmToolGate {
    const holdMs = deps.holdMs ?? CONFIRM_HOLD_MS
    return async (name, args, run) => {
        const toolId = toAssistantToolId(name)
        if (!isAssistantAlwaysAskTool(toolId) && (deps.isAlwaysProceed() || await deps.hasGrant(toolId))) {
            return run()
        }

        const decision = deps.ask(toolId, args).then(
            (completion) => completion,
            (): PermissionCompletion => ({ status: 'canceled' })
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        const early = await Promise.race([
            decision,
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), holdMs) })
        ])
        clearTimeout(timer)

        if (early) {
            if (early.status === 'approved') return run()
            if (early.status === 'denied') return text(refusal(name, early), true)
            return text(`${name} was canceled before the person answered.`, true)
        }

        void decision.then(async (completion) => {
            // Canceled means the turn was aborted or the session is ending:
            // nobody is waiting for news of it.
            if (completion.status === 'canceled') return
            if (completion.status === 'denied') {
                deps.deliver(`[dugong] ${refusal(name, completion)}`)
                return
            }
            const result = await run().catch((error: unknown) =>
                text(error instanceof Error ? error.message : String(error), true))
            deps.deliver([
                `[dugong] The person approved ${name}, and it has now run${result.isError ? ' and failed' : ''}.`,
                `Result: ${resultText(result)}`,
                'Carry on from here.'
            ].join('\n'))
        }).catch((error: unknown) => {
            logger.debug('[assistantToolGate] deferred tool failed', error)
        })
        return text(
            `Asked the person to approve ${name}; they have not answered yet. `
            + 'Do not call it again for this. The outcome will arrive in a later message; '
            + 'meanwhile carry on with anything that does not depend on it, or end your turn.'
        )
    }
}
