import type { SideQuestionFailureCode, SideQuestionRpcResult } from '@hapi/protocol/apiTypes'
import { query } from './sdk/query'
import type { SDKUserMessage } from './sdk/types'
import { filterCatalogAffectingClaudeArgs } from './sdk/metadataExtractor'
import { logger } from '@/ui/logger'

// Under the hub's 180 s RPC timeout, so the web gets our readable timeout
// rather than a bare RPC failure. Covers every attempt, not each one.
const SIDE_QUESTION_TIMEOUT_MS = 150_000

// Each rejected tool call costs a turn. A long agentic history makes the
// fork reach for Bash/Read/Grep before answering, so 2 turns was not enough.
const SIDE_QUESTION_MAX_TURNS = 4

// Without this the fork treats the question as the next turn of the main
// task (continues troubleshooting, or ends the turn with no text at all).
const SIDE_QUESTION_SYSTEM_PROMPT = 'The user is asking a quick side question (/btw) while the main task continues elsewhere. '
    + 'Answer only that question, directly and concisely, in plain text, from the conversation context above. '
    + 'Do not continue the main task. '
    + 'Every tool is disabled for this reply (Bash, Read, Grep, Edit, Agent, MCP tools, all of them) and any tool call is rejected. '
    + 'Do not call tools, not even to check a file or run a command. '
    + 'If the conversation above is not enough to answer with certainty, say so and give your best answer from what is there.'

// The system prompt alone does not stop the tool calls; the same words next
// to the question do (forks of a tool-heavy session answered on turn 1).
const SIDE_QUESTION_REMINDER = '<system-reminder>This is a /btw side question. All tools are disabled for this reply '
    + 'and every tool call will be rejected. Answer in plain text right away from the conversation so far; '
    + 'do not try to check files or run commands first.</system-reminder>'

const SIDE_QUESTION_RETRY_REMINDER = '<system-reminder>This is a /btw side question. Reply with text only. '
    + 'There are no tools in this reply: a tool call is rejected and ends the reply with no answer. '
    + 'Answer now from the conversation so far, and say so if you are not certain.</system-reminder>'

export class SideQuestionError extends Error {
    constructor(message: string, readonly code: SideQuestionFailureCode) {
        super(message)
        this.name = 'SideQuestionError'
    }
}

type AttemptOutcome =
    | { type: 'answer'; text: string }
    // Every turn went to a tool call; a fresh fork may still answer.
    | { type: 'tool-loop'; reason: string }
    | { type: 'no-answer'; reason: string }

// Sent as a stream-json user message, not `--print <text>`: as an argv
// entry a question starting with `-` would be parsed as a Claude CLI option.
async function* questionInput(question: string, reminder: string): AsyncIterable<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: `${question.trim()}\n\n${reminder}` } }
}

async function askOnce(opts: {
    nativeSessionId: string
    question: string
    reminder: string
    cwd: string
    model?: string
    claudeArgs?: readonly string[]
    signal: AbortSignal
}): Promise<AttemptOutcome> {
    const abortController = new AbortController()
    const stop = () => abortController.abort()
    opts.signal.addEventListener('abort', stop)
    try {
        const sideQuery = query({
            prompt: questionInput(opts.question, opts.reminder),
            options: {
                cwd: opts.cwd,
                resume: opts.nativeSessionId,
                forkSession: true,
                model: opts.model,
                maxTurns: SIDE_QUESTION_MAX_TURNS,
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
                return { type: 'answer', text: result }
            }
            logger.debug('[sideQuestion] empty result', message)
            const reason = `Claude returned no answer (${subtype ?? 'unknown'}${stopReason ? `, ${stopReason}` : ''})`
            return subtype === 'error_max_turns' && stopReason === 'tool_use'
                ? { type: 'tool-loop', reason }
                : { type: 'no-answer', reason }
        }
        return { type: 'no-answer', reason: 'Claude exited without an answer' }
    } finally {
        opts.signal.removeEventListener('abort', stop)
        // Returning (or throwing) out of the loop leaves the fork running
        // with nobody reading it; stop it.
        abortController.abort()
    }
}

/**
 * Web equivalent of Claude Code's `/btw` (TUI-only; headless replies
 * "/btw isn't available in this environment").
 *
 * Forks the native session into a throwaway, tool-less, non-persisted
 * process: the answer sees the full conversation, the main session's
 * transcript is untouched, and a running turn is not interrupted.
 * A fork that spends every turn on tool calls is retried once.
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
        const first = await askOnce({ ...opts, reminder: SIDE_QUESTION_REMINDER, signal: abortController.signal })
        if (first.type === 'answer') return first.text
        if (first.type === 'tool-loop') {
            logger.debug(`[sideQuestion] retrying: ${first.reason}`)
            const second = await askOnce({ ...opts, reminder: SIDE_QUESTION_RETRY_REMINDER, signal: abortController.signal })
            if (second.type === 'answer') return second.text
            throw new SideQuestionError(second.reason, 'side_question_no_answer')
        }
        throw new SideQuestionError(first.reason, 'side_question_no_answer')
    } catch (error) {
        if (timedOut) {
            throw new SideQuestionError('Side question timed out', 'side_question_timeout')
        }
        logger.debug('[sideQuestion] failed', error)
        throw error
    } finally {
        clearTimeout(timeout)
        abortController.abort()
    }
}

type SideQuestionOptions = Parameters<typeof askClaudeSideQuestion>[0]

/** RPC form, shared by the session process and the runner: a fork with no answer comes back with a code. */
export async function answerSideQuestionRpc(opts: SideQuestionOptions): Promise<SideQuestionRpcResult> {
    try {
        return { answer: await askClaudeSideQuestion(opts) }
    } catch (error) {
        if (error instanceof SideQuestionError) {
            return { error: error.message, code: error.code }
        }
        throw error
    }
}
