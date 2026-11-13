import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall, ToolCallBlock, ToolPermission } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { getAnsweredQuestionItems } from '@/components/ToolCard/questionAnswers'
import { I18nProvider } from '@/lib/i18n-context'

const QUESTIONS = [
    {
        header: 'Where',
        question: 'Where did the message go missing?',
        options: [{ label: 'Web chat', description: 'In the thread' }, { label: 'Export', description: 'In a file' }],
        multiSelect: false
    },
    {
        header: 'When',
        question: 'When did it disappear?',
        options: [{ label: 'After refresh', description: 'Reload' }],
        multiSelect: false
    }
]

function makeTool(overrides: Partial<ChatToolCall> = {}, permission?: Partial<ToolPermission>): ChatToolCall {
    return {
        id: 'toolu_1',
        name: 'AskUserQuestion',
        state: 'completed',
        input: { questions: QUESTIONS },
        createdAt: 1_000,
        startedAt: 1_000,
        completedAt: 2_000,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        result: 'The user answered.',
        permission: { id: 'toolu_1', status: 'approved', ...permission },
        ...overrides
    }
}

describe('getAnsweredQuestionItems', () => {
    it('keeps picked options and flags text the user typed themselves', () => {
        const tool = makeTool({}, { answers: { '0': ['Web chat'], '1': ['did you change something? it shows up now'] } })

        expect(getAnsweredQuestionItems(tool)).toEqual([
            { key: '0', question: 'Where did the message go missing?', answers: [{ text: 'Web chat', custom: false }] },
            {
                key: '1',
                question: 'When did it disappear?',
                answers: [{ text: 'did you change something? it shows up now', custom: true }]
            }
        ])
    })

    it('reads the nested { answers } shape too', () => {
        const tool = makeTool({}, { answers: { '0': { answers: ['Export'] } } })

        expect(getAnsweredQuestionItems(tool)).toEqual([
            { key: '0', question: 'Where did the message go missing?', answers: [{ text: 'Export', custom: false }] }
        ])
    })

    it('shows nothing while the question is still waiting for an answer', () => {
        const tool = makeTool({ state: 'pending' }, { status: 'pending', answers: { '0': ['Web chat'] } })

        expect(getAnsweredQuestionItems(tool)).toEqual([])
    })

    it('maps Cursor option ids back to their labels', () => {
        const tool = makeTool({
            name: 'CursorAskQuestion',
            input: {
                title: 'Pick',
                questions: [{ id: 'q-where', prompt: 'Where?', options: [{ id: 'opt-web', label: 'Web chat' }] }]
            }
        }, { answers: { 'q-where': ['opt-web'] } })

        const items = getAnsweredQuestionItems(tool)
        expect(items).toHaveLength(1)
        expect(items[0]?.answers).toEqual([{ text: 'Web chat', custom: false }])
    })

    it('turns a request_user_input note into a custom answer', () => {
        const tool = makeTool({
            name: 'request_user_input',
            input: {
                questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'All', description: null }] }]
            }
        }, { answers: { scope: { answers: ['All', 'user_note: but skip the tests'] } } })

        expect(getAnsweredQuestionItems(tool)).toEqual([
            {
                key: 'scope',
                question: 'Which scope?',
                answers: [{ text: 'All', custom: false }, { text: 'but skip the tests', custom: true }]
            }
        ])
    })
})

describe('answered question card', () => {
    it('shows the reply in the thread without opening the details dialog', () => {
        const block: ToolCallBlock = {
            kind: 'tool-call',
            id: 'toolu_1',
            localId: null,
            createdAt: 1_000,
            tool: makeTool({}, { answers: { '0': ['Web chat'], '1': ['it shows up now'] } }),
            children: []
        }

        render(
            <I18nProvider>
                <ToolCard
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={null}
                    terminalToolDisplayMode="compact"
                    disabled={false}
                    onDone={() => {}}
                    block={block}
                />
            </I18nProvider>
        )

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByText('Web chat')).toBeInTheDocument()
        expect(screen.getByText('it shows up now')).toBeInTheDocument()
        expect(screen.getByText('Custom answer')).toBeInTheDocument()
        expect(screen.getByText('When did it disappear?')).toBeInTheDocument()
    })
})
