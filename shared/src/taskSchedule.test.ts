import { describe, expect, it } from 'bun:test'
import {
    isUnattendedSpawn,
    nextScheduleRun,
    nextScheduleRuns,
    scheduleGraceMs,
    validateSchedule
} from './taskSchedule'

const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

describe('cron arithmetic', () => {
    it('reads the fields in the schedule\'s zone', () => {
        const runs = nextScheduleRuns('0 9 * * 1-5', 'Asia/Shanghai', at('2026-10-16T00:00:00Z'), 3)
        expect(runs.map(iso)).toEqual([
            '2026-10-16T01:00:00.000Z',
            '2026-10-19T01:00:00.000Z',
            '2026-10-20T01:00:00.000Z'
        ])
    })

    it('fires strictly after the reference time', () => {
        expect(iso(nextScheduleRun('0 9 * * *', 'UTC', at('2026-10-16T09:00:00Z')))).toBe('2026-10-17T09:00:00.000Z')
    })

    it('moves a fire inside the spring-forward gap to after it', () => {
        // 02:30 does not exist in New York on 2026-03-08; 03:30 EDT is 07:30Z.
        expect(iso(nextScheduleRun('30 2 * * *', 'America/New_York', at('2026-03-07T12:00:00Z'))))
            .toBe('2026-03-08T07:30:00.000Z')
    })

    it('fires a daily job once on the fall-back day', () => {
        const runs = nextScheduleRuns('30 1 * * *', 'America/New_York', at('2026-10-31T12:00:00Z'), 2)
        expect(runs.map(iso)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
    })

    it('gives half the period as grace, capped at an hour and floored at a minute', () => {
        const from = at('2026-10-16T00:00:00Z')
        expect(scheduleGraceMs('0 * * * *', 'UTC', from)).toBe(30 * 60_000)
        expect(scheduleGraceMs('0 9 * * *', 'UTC', from)).toBe(60 * 60_000)
    })
})

describe('validateSchedule', () => {
    const now = at('2026-10-16T00:00:00Z')

    it('accepts five fields and nicknames', () => {
        expect(validateSchedule('0 9 * * 1-5', 'Asia/Shanghai', now)).toEqual({ ok: true })
        expect(validateSchedule('@daily', 'UTC', now)).toEqual({ ok: true })
    })

    it('refuses anything that is not five fields', () => {
        expect(validateSchedule('0 0 9 * * *', 'UTC', now)).toMatchObject({ ok: false, code: 'invalid-cron' })
        expect(validateSchedule('* * * *', 'UTC', now)).toMatchObject({ ok: false, code: 'invalid-cron' })
        expect(validateSchedule('@sometimes', 'UTC', now)).toMatchObject({ ok: false, code: 'invalid-cron' })
    })

    it('refuses an unknown zone, a date that never comes, and a schedule under ten minutes', () => {
        expect(validateSchedule('0 9 * * *', 'Mars/Olympus', now)).toMatchObject({ ok: false, code: 'invalid-timezone' })
        expect(validateSchedule('0 0 30 2 *', 'UTC', now)).toMatchObject({ ok: false, code: 'never-fires' })
        expect(validateSchedule('0,5 9 * * *', 'UTC', now)).toMatchObject({ ok: false, code: 'too-frequent' })
    })
})

describe('isUnattendedSpawn', () => {
    it('accepts the hands-off modes and the agents that default to auto', () => {
        expect(isUnattendedSpawn({ flavor: 'claude' })).toBe(true)
        expect(isUnattendedSpawn({ flavor: 'codex', permissionMode: 'yolo' })).toBe(true)
        expect(isUnattendedSpawn({ flavor: 'gemini', yolo: true })).toBe(true)
    })

    it('refuses modes that stop to ask', () => {
        expect(isUnattendedSpawn({ flavor: 'claude', permissionMode: 'default' })).toBe(false)
        expect(isUnattendedSpawn({ flavor: 'claude', permissionMode: 'plan' })).toBe(false)
        expect(isUnattendedSpawn({ flavor: 'gemini' })).toBe(false)
    })
})
