import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import en from '@/lib/locales/en'
import { pausedLabel, scheduleErrorText, slotReasonLabel } from './TaskScheduleSection'

function t(key: string, params?: Record<string, string>): string {
    const template: string = (en as Record<string, string>)[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? '')
}

function refusal(status: number, payload: { error: string; code?: string }): ApiError {
    const body = JSON.stringify(payload)
    return new ApiError(`HTTP ${status}: ${body}`, status, payload.code ?? payload.error, body)
}

describe('scheduleErrorText', () => {
    it('words a validation refusal', () => {
        expect(scheduleErrorText(refusal(400, { error: 'too-frequent', code: 'schedule_too-frequent' }), t))
            .toBe('Runs must be at least 10 minutes apart.')
    })

    it('words the run-now refusals', () => {
        expect(scheduleErrorText(refusal(409, { error: 'Task is already running', code: 'task_running' }), t))
            .toBe('This task is already running.')
        expect(scheduleErrorText(refusal(409, { error: 'offline', code: 'machine_offline' }), t))
            .toBe('The task\'s machine is offline.')
        expect(scheduleErrorText(refusal(502, { error: 'runner refused', code: 'spawn_failed' }), t))
            .toBe('The agent did not start: runner refused')
    })

    it('shows the hub\'s own words for anything else, never a raw key', () => {
        // With no `code`, the client takes `error` as the code.
        expect(scheduleErrorText(refusal(404, { error: 'Schedule not found' }), t)).toBe('Schedule not found')
        expect(scheduleErrorText(new Error('Network down'), t)).toBe('Network down')
    })
})

describe('schedule reasons', () => {
    it('words every reason a slot can carry', () => {
        expect(slotReasonLabel('archived', t)).toBe('task archived')
        expect(slotReasonLabel('not-worktree', t)).toBe('Only tasks that run in a worktree can be scheduled.')
        expect(slotReasonLabel('runner said no', t)).toBe('runner said no')
    })

    it('says why a schedule is paused', () => {
        expect(pausedLabel('failures', t)).toBe('Paused after 3 failed runs in a row')
        expect(pausedLabel('archived', t)).toBe('Paused: This task is archived.')
        expect(pausedLabel('user', t)).toBe('Paused')
        expect(pausedLabel(null, t)).toBe('Paused')
    })
})
