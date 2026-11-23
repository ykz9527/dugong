import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SideQuestionError } from './sideQuestion'

const queryMock = vi.fn()
vi.mock('./sdk/query', () => ({ query: (...args: unknown[]) => queryMock(...args) }))

async function* stream(messages: unknown[]) {
    for (const message of messages) yield message
}

afterEach(() => {
    queryMock.mockReset()
    vi.useRealTimers()
})

// What a fork of a tool-heavy session does: every turn is a tool call that
// `--tools ''` rejects, until --max-turns cuts it off with no text.
const toolLoop = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'No such tool available: Bash' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'No such tool available: Read' }] } },
    { type: 'result', subtype: 'error_max_turns', stop_reason: 'tool_use', is_error: true, num_turns: 3 }
]

describe('askClaudeSideQuestion', () => {
    it('skips the result a running background task replays and returns the answer', async () => {
        queryMock.mockReturnValueOnce(stream([
            { type: 'result', subtype: 'success', result: '', num_turns: 0, origin: { kind: 'task-notification' } },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'About ten minutes.' }] } },
            { type: 'result', subtype: 'success', result: 'About ten minutes.', num_turns: 1 }
        ]))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        await expect(askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How much longer?',
            cwd: process.cwd()
        })).resolves.toBe('About ten minutes.')
    })

    it('still fails on an empty answer to the question itself', async () => {
        queryMock.mockReturnValueOnce(stream([
            { type: 'result', subtype: 'success', result: '', num_turns: 1 }
        ]))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        await expect(askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How much longer?',
            cwd: process.cwd()
        })).rejects.toThrow('Claude returned no answer (success)')
    })

    it('sends the question on stdin rather than argv and stops the fork once answered', async () => {
        queryMock.mockReturnValueOnce(stream([
            { type: 'result', subtype: 'success', result: 'It is a flag.', num_turns: 1 }
        ]))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        await expect(askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: '--help, what does that do?',
            cwd: process.cwd()
        })).resolves.toBe('It is a flag.')

        const { prompt, options } = queryMock.mock.calls[0][0] as {
            prompt: AsyncIterable<unknown>
            options: { abort: AbortSignal; additionalArgs: string[] }
        }
        expect(typeof prompt).not.toBe('string')
        const sent: unknown[] = []
        for await (const message of prompt) sent.push(message)
        expect(sent).toHaveLength(1)
        const content = (sent[0] as { message: { content: string } }).message.content
        // The question goes first; a no-tools reminder rides along with it.
        expect(content.startsWith('--help, what does that do?\n\n<system-reminder>')).toBe(true)
        expect(options.additionalArgs.join(' ')).not.toContain('--help, what does that do?')
        expect(options.abort.aborted).toBe(true)
    })

    it('stops the fork when the answer is empty', async () => {
        queryMock.mockReturnValueOnce(stream([
            { type: 'result', subtype: 'success', result: '', num_turns: 1 }
        ]))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        await expect(askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How much longer?',
            cwd: process.cwd()
        })).rejects.toThrow('Claude returned no answer (success)')
        const { options } = queryMock.mock.calls[0][0] as { options: { abort: AbortSignal } }
        expect(options.abort.aborted).toBe(true)
    })

    it('retries a fork that spent every turn on tool calls and returns the second answer', async () => {
        queryMock
            .mockReturnValueOnce(stream(toolLoop))
            .mockReturnValueOnce(stream([
                { type: 'result', subtype: 'success', stop_reason: 'end_turn', result: 'Half done.', num_turns: 1 }
            ]))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        await expect(askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How far along is the schema?',
            cwd: process.cwd()
        })).resolves.toBe('Half done.')

        expect(queryMock).toHaveBeenCalledTimes(2)
        for (const [{ options }] of queryMock.mock.calls as [[{ options: { forkSession: boolean; maxTurns: number; abort: AbortSignal } }]]) {
            expect(options.forkSession).toBe(true)
            expect(options.maxTurns).toBeGreaterThan(2)
            expect(options.abort.aborted).toBe(true)
        }
    })

    it('gives up with a no-answer code when the retry also ends on a tool call', async () => {
        queryMock
            .mockReturnValueOnce(stream(toolLoop))
            .mockReturnValueOnce(stream(toolLoop))
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        const error = await askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How far along is the schema?',
            cwd: process.cwd()
        }).catch((e: unknown) => e as SideQuestionError)

        expect(error).toMatchObject({
            code: 'side_question_no_answer',
            message: 'Claude returned no answer (error_max_turns, tool_use)'
        })
        expect(queryMock).toHaveBeenCalledTimes(2)
    })

    it('reports a timeout with its own code and stops the fork', async () => {
        vi.useFakeTimers()
        queryMock.mockImplementationOnce(({ options }: { options: { abort: AbortSignal } }) => (async function* () {
            await new Promise((_, reject) => {
                options.abort.addEventListener('abort', () => reject(new Error('aborted')))
            })
            yield { type: 'result' }
        })())
        const { askClaudeSideQuestion } = await import('./sideQuestion')

        const pending = askClaudeSideQuestion({
            nativeSessionId: 'native-1',
            question: 'How far along is the schema?',
            cwd: process.cwd()
        }).catch((e: unknown) => e as SideQuestionError)
        await vi.advanceTimersByTimeAsync(180_000)

        expect(await pending).toMatchObject({ code: 'side_question_timeout' })
        const { options } = queryMock.mock.calls[0][0] as { options: { abort: AbortSignal } }
        expect(options.abort.aborted).toBe(true)
    })
})
