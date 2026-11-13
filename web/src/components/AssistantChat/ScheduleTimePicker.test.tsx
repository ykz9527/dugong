import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ScheduleTimePicker } from './ScheduleTimePicker'

describe('ScheduleTimePicker interactions', () => {
    it('schedules the picked day and time from the specific tab', () => {
        const anchorRef = { current: document.createElement('button') }
        const onSchedule = vi.fn()
        const onClose = vi.fn()

        render(
            <I18nProvider>
                <ScheduleTimePicker
                    anchorRef={anchorRef}
                    onSchedule={onSchedule}
                    onClose={onClose}
                    pendingSchedule={null}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /specific/i }))
        fireEvent.click(screen.getByRole('button', { name: /tomorrow/i }))
        fireEvent.click(within(screen.getByRole('listbox', { name: /hour/i })).getByRole('option', { name: '08' }))
        fireEvent.click(within(screen.getByRole('listbox', { name: /minute/i })).getByRole('option', { name: '30' }))
        fireEvent.click(screen.getAllByRole('button', { name: /schedule/i }).at(-1)!)

        const today = new Date()
        const expected = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 8, 30).getTime()
        expect(onSchedule).toHaveBeenCalledWith({ type: 'absolute', ms: expected })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
