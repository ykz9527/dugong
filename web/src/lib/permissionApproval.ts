import { getInputStringAny } from '@/lib/toolInputUtils'

export type ApproveForSessionOptions =
    | { allowTools: string[] }
    | { decision: 'approved_for_session' }

/**
 * What to send to approve a tool request for the rest of the session.
 *
 * Agents disagree on how to say it. Claude's CLI handler ignores `decision`
 * and only reads `allowTools` (a Bash request is allowed by its exact
 * command); every other agent takes `decision: 'approved_for_session'`.
 * Sending the wrong one approves just this call.
 */
export function approveForSessionOptions(
    flavor: string | null | undefined,
    toolName: string,
    toolInput: unknown
): ApproveForSessionOptions {
    if (flavor !== 'claude') {
        return { decision: 'approved_for_session' }
    }
    const command = toolName === 'Bash' ? getInputStringAny(toolInput, ['command', 'cmd']) : null
    return { allowTools: [command ? `Bash(${command})` : toolName] }
}
