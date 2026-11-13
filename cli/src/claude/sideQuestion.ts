import { query } from './sdk/query'
import type { SDKUserMessage } from './sdk/types'
import { filterCatalogAffectingClaudeArgs } from './sdk/metadataExtractor'
import { logger } from '@/ui/logger'

const SIDE_QUESTION_TIMEOUT_MS = 180_000

// Without this the fork treats the question as the next turn of the main
// task (continues troubleshooting, or ends the turn with no text at all).
const SIDE_QUESTION_SYSTEM_PROMPT = 'The user is asking a quick side question (/btw) while the main task continues elsewhere. '
    + 'Answer only that question, directly and concisely, from the conversation context above. '
    + 'Do not continue the main task. You have no tools in this reply.'

// Sent as a stream-json user message, not `--print <text>`: as an argv
// entry a question starting with `-` would be parsed as a Claude CLI option.
async function* questionInput(question: string): AsyncIterable<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: question.trim() } }
}

/**
 * Web equivalent of Claude Code's `/btw` (TUI-only; headless replies
 * "/btw isn't available in this environment").
 *
 * Forks the native session into a throwaway, tool-less, non-persisted
 * process: the answer sees the full conversation, the main session's
 * transcript is untouched, and a running turn is not interrupted.
 */
export async function askClaudeSideQuestion(opts: {
    nativeSessionId: string
    question: string
    cwd: string
    model?: string
    claudeArgs?: readonly string[]
}): Promise<string> {
    const abortController = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
        timedOut = true
        abortController.abort()
    }, SIDE_QUESTION_TIMEOUT_MS)
    try {
        const sideQuery = query({
            prompt: questionInput(opts.question),
            options: {
                cwd: opts.cwd,
                resume: opts.nativeSessionId,
                forkSession: true,
                model: opts.model,
                // A stray tool call (history is full of them) gets a "no such
                // tool" error on turn 1; turn 2 is the actual answer.
                maxTurns: 2,
                appendSystemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
                additionalArgs: [
                    ...filterCatalogAffectingClaudeArgs(opts.claudeArgs),
                    '--no-session-persistence',
                    // --tools only covers built-ins; also drop MCP servers.
                    '--tools', '',
                    '--strict-mcp-config'
                ],
                abort: abortController.signal
            }
        })
        for await (const message of sideQuery) {
            if (message.type !== 'result') continue
            const { result, subtype, stop_reason: stopReason, origin } = message as {
                result?: unknown
                subtype?: string
                stop_reason?: string | null
                origin?: { kind?: string }
            }
            // A session with a background task still running replays its
            // notification when forked, and Claude Code closes that with a
            // result of its own (empty, no turns) before it reads the question.
            // That is not the answer; keep waiting for the one that is.
            if (origin?.kind === 'task-notification') continue
            if (typeof result === 'string' && result.trim()) {
                return result
            }
            logger.debug('[sideQuestion] empty result', message)
            throw new Error(`Claude returned no answer (${subtype ?? 'unknown'}${stopReason ? `, ${stopReason}` : ''})`)
        }
        throw new Error('Claude exited without an answer')
    } catch (error) {
        if (timedOut) {
            throw new Error('Side question timed out')
        }
        logger.debug('[sideQuestion] failed', error)
        throw error
    } finally {
        clearTimeout(timeout)
        // Returning (or throwing) out of the loop leaves the fork running
        // with nobody reading it; stop it.
        abortController.abort()
    }
}
