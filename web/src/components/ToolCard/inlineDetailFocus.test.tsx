import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

const block: ToolCallBlock = {
    kind: 'tool-call', id: 'bash-1', localId: null, createdAt: 1_000,
    tool: {
        id: 'bash-1', name: 'Bash', state: 'completed', input: { command: 'echo preview' },
        createdAt: 1_000, startedAt: 1_000, completedAt: 1_100, execStartedAt: null, execCompletedAt: null, description: null,
    }, children: [],
}

describe('ToolCard inline detail focus', () => {
    it('opens the header row inline and restores focus to an inline preview invoker', async () => {
        const { container } = render(
            <I18nProvider><ToolCard api={{} as ApiClient} sessionId="session-1" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} /></I18nProvider>
        )

        // Header row: a ledger row that opens in place and shows the timestamps.
        const headerRow = container.querySelector('button')!
        expect(headerRow).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('Started')).toBeNull()
        fireEvent.click(headerRow)
        expect(headerRow).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).toBeNull()

        const inlinePreview = container.querySelector('[role="button"]') as HTMLElement
        fireEvent.click(inlinePreview)
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(inlinePreview).toHaveFocus())
    })
})
