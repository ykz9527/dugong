import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SidebarHeader } from './SidebarHeader'

afterEach(() => {
    cleanup()
})

function renderHeader(props: Partial<React.ComponentProps<typeof SidebarHeader>> = {}) {
    render(
        <I18nProvider>
            <SidebarHeader attentionCount={0} {...props} />
        </I18nProvider>
    )
}

describe('SidebarHeader', () => {
    it('offers no separate session list', () => {
        renderHeader()

        expect(screen.queryByRole('tab')).toBeNull()
        expect(screen.getByText('Tasks')).toBeTruthy()
    })

    it('badges the count of cards waiting on a human', () => {
        renderHeader({ attentionCount: 3 })

        expect(screen.getByTitle(/3/).textContent).toBe('3')
    })

    it('has no badge when nothing is waiting', () => {
        renderHeader({ attentionCount: 0 })

        expect(screen.queryByTitle(/waiting|等你/)).toBeNull()
    })

    it('keeps the sidebar actions reachable', () => {
        renderHeader({ actions: <button type="button">Settings</button> })

        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })
})
