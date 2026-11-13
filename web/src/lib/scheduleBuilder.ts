/**
 * The schedule editor's structured form, and its two-way mapping to cron.
 *
 * People describe schedules as "every 15 minutes" or "Mon/Wed/Fri at 9", not
 * as cron. The editor offers those shapes and turns them into the cron the hub
 * stores; opening a saved schedule reads the cron back into the same shape
 * when it matches one, and falls back to the raw-cron "advanced" form when it
 * does not.
 */

export type ScheduleMode = 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'advanced'

export type ScheduleForm = {
    mode: ScheduleMode
    /** `minutes`: every N minutes. */
    everyMinutes: number
    /** `hours`: every N hours, at `minute` past. */
    everyHours: number
    minute: number
    /** `daily` / `weekly` / `monthly`: "HH:MM". */
    time: string
    /** `weekly`: 0 = Sunday … 6 = Saturday. */
    weekdays: number[]
    /** `monthly`: 1–28, or 'last'. */
    monthDay: number | 'last'
    /** `advanced`: the cron as typed. */
    cron: string
}

export const MINUTE_STEPS = [10, 15, 20, 30] as const
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const WORKDAYS = [1, 2, 3, 4, 5]
export const WEEKEND = [0, 6]
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

export const DEFAULT_FORM: ScheduleForm = {
    mode: 'daily',
    everyMinutes: 30,
    everyHours: 1,
    minute: 0,
    time: '09:00',
    weekdays: [...WORKDAYS],
    monthDay: 1,
    cron: ''
}

function splitTime(time: string): { hour: number; minute: number } {
    const [hour = '9', minute = '0'] = time.split(':')
    return { hour: Number(hour) || 0, minute: Number(minute) || 0 }
}

function joinTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** "1-5" for a run of consecutive days, else a sorted list. */
function weekdayField(days: readonly number[]): string {
    const sorted = [...new Set(days)].sort((a, b) => a - b)
    if (sorted.length === 7) return '*'
    const contiguous = sorted.length > 2 && sorted.every((day, i) => i === 0 || day === sorted[i - 1]! + 1)
    return contiguous ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(',')
}

function parseWeekdayField(field: string): number[] | null {
    if (field === '*') return [...ALL_DAYS]
    const days = new Set<number>()
    for (const part of field.split(',')) {
        const range = /^(\d)-(\d)$/.exec(part)
        if (range) {
            const from = Number(range[1])
            const to = Number(range[2])
            if (from > to) return null
            for (let day = from; day <= to; day++) days.add(day % 7)
            continue
        }
        if (!/^\d$/.test(part)) return null
        days.add(Number(part) % 7)
    }
    return [...days].sort((a, b) => a - b)
}

/** The cron for a form, or '' when the form cannot produce one yet (no
 *  weekday picked). Validation proper is `validateSchedule`'s job. */
export function formToCron(form: ScheduleForm): string {
    const { hour, minute } = splitTime(form.time)
    switch (form.mode) {
        case 'minutes':
            return `*/${form.everyMinutes} * * * *`
        case 'hours':
            return form.everyHours === 1 ? `${form.minute} * * * *` : `${form.minute} */${form.everyHours} * * *`
        case 'daily':
            return `${minute} ${hour} * * *`
        case 'weekly':
            return form.weekdays.length === 0 ? '' : `${minute} ${hour} * * ${weekdayField(form.weekdays)}`
        case 'monthly':
            return `${minute} ${hour} ${form.monthDay === 'last' ? 'L' : form.monthDay} * *`
        case 'advanced':
            return form.cron.trim()
    }
}

const NUM = '(\\d{1,2})'

/** Read a stored cron back into the form that produces it; anything else
 *  opens in the advanced form with the cron as typed. */
export function cronToForm(cron: string): ScheduleForm {
    const trimmed = cron.trim()
    const base: ScheduleForm = { ...DEFAULT_FORM, cron: trimmed }
    const fields = trimmed.split(/\s+/)
    if (fields.length !== 5) return { ...base, mode: 'advanced' }
    const [min, hr, dom, mon, dow] = fields as [string, string, string, string, string]
    if (mon !== '*') return { ...base, mode: 'advanced' }

    const step = /^\*\/(\d+)$/
    const minuteStep = step.exec(min)
    if (minuteStep && hr === '*' && dom === '*' && dow === '*') {
        const every = Number(minuteStep[1])
        if ((MINUTE_STEPS as readonly number[]).includes(every)) return { ...base, mode: 'minutes', everyMinutes: every }
        return { ...base, mode: 'advanced' }
    }

    if (!new RegExp(`^${NUM}$`).test(min)) return { ...base, mode: 'advanced' }
    const minute = Number(min)
    if (minute > 59) return { ...base, mode: 'advanced' }

    if (dom === '*' && dow === '*') {
        if (hr === '*') return { ...base, mode: 'hours', everyHours: 1, minute }
        const hourStep = step.exec(hr)
        if (hourStep) {
            const every = Number(hourStep[1])
            if ((HOUR_STEPS as readonly number[]).includes(every)) return { ...base, mode: 'hours', everyHours: every, minute }
            return { ...base, mode: 'advanced' }
        }
    }

    if (!new RegExp(`^${NUM}$`).test(hr) || Number(hr) > 23) return { ...base, mode: 'advanced' }
    const time = joinTime(Number(hr), minute)

    if (dom === '*' && dow === '*') return { ...base, mode: 'daily', time }
    if (dom === '*') {
        const weekdays = parseWeekdayField(dow)
        return weekdays ? { ...base, mode: 'weekly', time, weekdays } : { ...base, mode: 'advanced' }
    }
    if (dow === '*') {
        if (dom === 'L') return { ...base, mode: 'monthly', time, monthDay: 'last' }
        const day = Number(dom)
        if (/^\d{1,2}$/.test(dom) && day >= 1 && day <= 28) return { ...base, mode: 'monthly', time, monthDay: day }
    }
    return { ...base, mode: 'advanced' }
}
