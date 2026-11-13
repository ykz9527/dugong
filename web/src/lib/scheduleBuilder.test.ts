import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, cronToForm, formToCron, type ScheduleForm } from './scheduleBuilder'

const form = (patch: Partial<ScheduleForm>): ScheduleForm => ({ ...DEFAULT_FORM, ...patch })

describe('formToCron', () => {
    it('builds each shape', () => {
        expect(formToCron(form({ mode: 'minutes', everyMinutes: 15 }))).toBe('*/15 * * * *')
        expect(formToCron(form({ mode: 'hours', everyHours: 1, minute: 5 }))).toBe('5 * * * *')
        expect(formToCron(form({ mode: 'hours', everyHours: 2, minute: 30 }))).toBe('30 */2 * * *')
        expect(formToCron(form({ mode: 'daily', time: '08:05' }))).toBe('5 8 * * *')
        expect(formToCron(form({ mode: 'weekly', time: '09:00', weekdays: [5, 1, 2, 3, 4] }))).toBe('0 9 * * 1-5')
        expect(formToCron(form({ mode: 'weekly', time: '09:00', weekdays: [1, 3, 5] }))).toBe('0 9 * * 1,3,5')
        expect(formToCron(form({ mode: 'monthly', time: '18:30', monthDay: 'last' }))).toBe('30 18 L * *')
    })

    it('produces nothing for a week with no day picked', () => {
        expect(formToCron(form({ mode: 'weekly', weekdays: [] }))).toBe('')
    })
})

describe('cronToForm', () => {
    it('reads every built shape back into the same form', () => {
        const shapes: Array<Partial<ScheduleForm>> = [
            { mode: 'minutes', everyMinutes: 20 },
            { mode: 'hours', everyHours: 1, minute: 15 },
            { mode: 'hours', everyHours: 6, minute: 0 },
            { mode: 'daily', time: '07:45' },
            { mode: 'weekly', time: '09:00', weekdays: [0, 6] },
            { mode: 'weekly', time: '21:10', weekdays: [1, 3, 5] },
            { mode: 'monthly', time: '10:00', monthDay: 15 },
            { mode: 'monthly', time: '10:00', monthDay: 'last' }
        ]
        for (const shape of shapes) {
            const cron = formToCron(form(shape))
            expect(formToCron(cronToForm(cron))).toBe(cron)
            expect(cronToForm(cron).mode).toBe(shape.mode)
        }
    })

    it('opens anything it cannot express in the advanced form', () => {
        for (const cron of ['0 9 1 1 *', '*/7 * * * *', '0 9 1 * 1', '0 9,18 * * *', '@daily', '0 9 31 * *']) {
            expect(cronToForm(cron)).toMatchObject({ mode: 'advanced', cron })
        }
    })
})
