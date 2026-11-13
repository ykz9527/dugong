import { afterEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()
vi.mock('./sdk/query', () => ({ query: (...args: unknown[]) => queryMock(...args) }))

async function* stream(messages: unknown[]) {
    for (const message of messages) yield message
}

afterEach(() => {
    queryMock.mockReset()
})

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
        expect(sent).toEqual([{ type: 'user', message: { role: 'user', content: '--help, what does that do?' } }])
        expect(options.additionalArgs).not.toContain('--help, what does that do?')
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
})
