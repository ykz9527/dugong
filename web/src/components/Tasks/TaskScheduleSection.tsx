import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import cronstrue from 'cronstrue'
import 'cronstrue/locales/zh_CN'
import {
    SCHEDULE_DEFAULT_MAX_RUN_MS,
    TASK_SCHEDULE_REASONS,
    TASK_SCHEDULE_REFUSALS,
    nextScheduleRuns,
    validateSchedule,
    type Task,
    type TaskSchedule,
    type TaskScheduleInput,
    type TaskScheduleOverlap,
    type TaskScheduleSessionMode,
    type TaskScheduleSlot
} from '@hapi/protocol'
import { ApiError, readableError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { MenuSelect, type MenuOption } from '@/components/ui/menu-select'
import { TimePickerField } from '@/components/ui/time-picker'
import type { Locale } from '@/lib/use-translation'
import {
    ALL_DAYS,
    DEFAULT_FORM,
    HOUR_STEPS,
    MINUTE_STEPS,
    WEEKDAY_ORDER,
    WEEKEND,
    WORKDAYS,
    cronToForm,
    formToCron,
    type ScheduleForm,
    type ScheduleMode
} from '@/lib/scheduleBuilder'

/**
 * Recurring runs for a task: a cron and time zone, what to do with a missed
 * or overlapping slot, and a time limit per run.
 *
 * The editor builds a cron from a handful of presets, or takes one typed in.
 * The preview — description and next fires — is computed here with the same
 * shared cron code the hub fires from, so what it shows is what will run.
 */

type Draft = {
    form: ScheduleForm
    tz: string
    catchup: boolean
    overlap: TaskScheduleOverlap
    sessionMode: TaskScheduleSessionMode
    maxRunMinutes: number
}

const MODES: ScheduleMode[] = ['minutes', 'hours', 'daily', 'weekly', 'monthly', 'advanced']
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)
const SLOT_LIMIT = 10

function browserTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Every zone the browser knows, for the picker; the current one first. */
function timeZoneOptions(current: string): MenuOption<string>[] {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    return [current, ...supported.filter((zone) => zone !== current)].map((zone) => ({ value: zone, label: zone }))
}

const MINUTE_OPTIONS: MenuOption<number>[] = Array.from({ length: 60 }, (_, minute) => ({
    value: minute,
    label: String(minute).padStart(2, '0')
}))

const MAX_RUN_MINUTES = [15, 30, 60, 90, 120, 180, 240, 360, 720, 1440]

type Translate = (key: string, params?: Record<string, string>) => string

const isRefusal = (code: string): boolean => (TASK_SCHEDULE_REFUSALS as readonly string[]).includes(code)

/** A slot's reason: a known code in words, a refusal as the matching save
 *  error, anything else (a dispatch failure's own text) as it came. */
export function slotReasonLabel(reason: string, t: Translate): string {
    if ((TASK_SCHEDULE_REASONS as readonly string[]).includes(reason)) return t(`board.schedule.reason.${reason}`)
    if (isRefusal(reason)) return t(`board.schedule.error.${reason}`)
    return reason
}

/** Why a schedule is paused: three failures, the task no longer qualifying,
 *  or the person pausing it. */
export function pausedLabel(reason: string | null, t: Translate): string {
    if (reason === 'failures') return t('board.schedule.pausedFailures')
    if (reason && isRefusal(reason)) return t('board.schedule.pausedBecause', { reason: t(`board.schedule.error.${reason}`) })
    return t('board.schedule.paused')
}

/** Time-limit choices, keeping a stored value that is not one of them. */
function maxRunOptions(current: number, t: (key: string, params?: Record<string, string>) => string): MenuOption<number>[] {
    const values = MAX_RUN_MINUTES.includes(current) ? MAX_RUN_MINUTES : [...MAX_RUN_MINUTES, current].sort((a, b) => a - b)
    return values.map((minutes) => ({
        value: minutes,
        label: minutes % 60 === 0
            ? t('board.schedule.duration.hours', { count: String(minutes / 60) })
            : t('board.schedule.duration.minutes', { count: String(minutes) })
    }))
}

function draftFromSchedule(schedule: TaskSchedule | null): Draft {
    if (!schedule) {
        return {
            form: { ...DEFAULT_FORM },
            tz: browserTimeZone(),
            catchup: true,
            overlap: 'skip',
            sessionMode: 'fresh',
            maxRunMinutes: SCHEDULE_DEFAULT_MAX_RUN_MS / 60_000
        }
    }
    return {
        form: cronToForm(schedule.cron),
        tz: schedule.tz,
        catchup: schedule.catchup,
        overlap: schedule.overlap,
        sessionMode: schedule.sessionMode,
        maxRunMinutes: Math.round(schedule.maxRunMs / 60_000)
    }
}

function describeCron(cron: string, locale: Locale): string | null {
    const text = cronstrue.toString(cron, {
        locale: locale === 'zh-CN' ? 'zh_CN' : 'en',
        use24HourTimeFormat: true,
        throwExceptionOnParseError: false
    })
    return text || null
}

function formatAt(at: number, tz: string, locale: Locale): string {
    return new Date(at).toLocaleString(locale, { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })
}

/** Codes the hub refuses a schedule with that have their own words here. */
const SCHEDULE_ERROR_CODES = new Set([
    // Spec and task refusals arrive as `schedule_<code>`.
    'invalid-cron', 'invalid-timezone', 'never-fires', 'too-frequent',
    'not-unattended', 'not-worktree', 'no-machine', 'adopted-task', 'invalid-spawn-config',
    // Run now.
    'task_running', 'machine_offline', 'spawn_failed'
])

/** A known refusal in our words; anything else in the hub's. */
export function scheduleErrorText(
    error: unknown,
    t: (key: string, params?: Record<string, string>) => string
): string {
    const message = readableError(error)
    const code = error instanceof ApiError ? error.code?.replace(/^schedule_/, '') : undefined
    return code && SCHEDULE_ERROR_CODES.has(code)
        ? t(`board.schedule.error.${code}`, { message })
        : message
}

// DESIGN.md: underline fields, pill buttons, black fill for a chosen chip.
const inputClass = 'border-0 border-b border-[var(--app-rule)] bg-transparent px-0 py-1 text-[13px] text-[var(--app-fg)] transition-[border-color] duration-300 focus:border-[var(--app-accent)] focus:outline-none'
const buttonClass = 'pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1 text-xs font-semibold text-[var(--app-fg)] disabled:pointer-events-none disabled:opacity-50'
const dangerClass = 'rounded-full border border-[var(--app-accent)] px-3 py-1 text-xs font-semibold text-[var(--app-accent)] transition-colors duration-300 hover:bg-[var(--app-accent)] hover:text-[var(--app-bg)] disabled:pointer-events-none disabled:opacity-50'
const chipClass = 'rounded-full border border-[var(--app-border)] px-2.5 py-0.5 text-xs text-[var(--app-hint)] transition-colors duration-300 hover:border-[var(--app-fg)] hover:text-[var(--app-fg)]'
const chipOnClass = 'rounded-full border border-[var(--app-fg)] bg-[var(--app-fg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--app-bg)]'
const linkClass = 'pw-underline text-xs font-semibold text-[var(--app-fg)]'
const rowClass = 'flex flex-wrap items-center gap-1.5 text-xs text-[var(--app-hint)]'

export function TaskScheduleSection(props: { api: ApiClient | null; task: Task }) {
    const { t, locale } = useTranslation()
    const queryClient = useQueryClient()
    const { api, task } = props

    const scheduleQuery = useQuery({
        queryKey: queryKeys.taskSchedule(task.id),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return (await api.getTaskSchedule(task.id)).schedule
        },
        enabled: Boolean(api),
        // The cursor moves on its own; keep "next run" honest without SSE.
        refetchInterval: 60_000
    })
    const schedule = scheduleQuery.data ?? null

    const slotsQuery = useQuery({
        queryKey: queryKeys.taskScheduleSlots(task.id),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return (await api.getTaskScheduleSlots(task.id, SLOT_LIMIT)).slots
        },
        enabled: Boolean(api && schedule),
        refetchInterval: 60_000
    })

    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState<Draft>(() => draftFromSchedule(null))
    const [errorText, setErrorText] = useState<string | null>(null)

    const cron = formToCron(draft.form)
    const setForm = (patch: Partial<ScheduleForm>) => setDraft({ ...draft, form: { ...draft.form, ...patch } })
    const zones = useMemo(() => timeZoneOptions(draft.tz), [draft.tz])
    const preview = useMemo(() => {
        if (!cron) return { error: t('board.schedule.error.no-weekday'), runs: [] as number[] }
        const validation = validateSchedule(cron, draft.tz)
        if (!validation.ok) return { error: t(`board.schedule.error.${validation.code}`), runs: [] as number[] }
        return { error: null, runs: nextScheduleRuns(cron, draft.tz, Date.now(), 3) }
    }, [cron, draft.tz, t])

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
    }
    const onError = (error: unknown) => {
        setErrorText(scheduleErrorText(error, t))
    }

    const save = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            const payload: TaskScheduleInput = {
                cron,
                tz: draft.tz,
                catchup: draft.catchup,
                overlap: draft.overlap,
                sessionMode: draft.sessionMode,
                maxRunMs: draft.maxRunMinutes * 60_000
            }
            return await api.saveTaskSchedule(task.id, payload)
        },
        onSuccess: () => {
            setEditing(false)
            setErrorText(null)
            refresh()
        },
        onError
    })
    const action = useMutation({
        mutationFn: async (kind: 'pause' | 'resume' | 'run-now' | 'delete') => {
            if (!api) throw new Error('API unavailable')
            if (kind === 'pause') await api.pauseTaskSchedule(task.id)
            if (kind === 'resume') await api.resumeTaskSchedule(task.id)
            if (kind === 'run-now') await api.runTaskScheduleNow(task.id)
            if (kind === 'delete') await api.deleteTaskSchedule(task.id)
        },
        onSuccess: () => {
            setErrorText(null)
            refresh()
        },
        onError
    })
    const busy = save.isPending || action.isPending

    const startEditing = () => {
        setDraft(draftFromSchedule(schedule))
        setErrorText(null)
        setEditing(true)
    }

    if (scheduleQuery.isLoading) return null

    return (
        <section>
            <h3 className="pw-eyebrow mb-2 text-[var(--app-hint)]">{t('board.schedule.title')}</h3>

            {!schedule && !editing ? (
                <div className="flex items-center gap-2">
                    <button type="button" className={buttonClass} disabled={busy || !api} onClick={startEditing}>
                        {t('board.schedule.add')}
                    </button>
                    <span className="text-xs text-[var(--app-hint)]">{t('board.schedule.addHint')}</span>
                </div>
            ) : null}

            {schedule && !editing ? (
                <ScheduleSummary
                    schedule={schedule}
                    slots={slotsQuery.data ?? []}
                    locale={locale}
                    busy={busy}
                    onEdit={startEditing}
                    onAction={(kind) => action.mutate(kind)}
                />
            ) : null}

            {editing ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1">
                        {MODES.map((mode) => (
                            <button
                                key={mode}
                                type="button"
                                aria-pressed={draft.form.mode === mode}
                                onClick={() => setForm(mode === 'advanced' && draft.form.mode !== 'advanced'
                                    ? { mode, cron: cron || draft.form.cron }
                                    : { mode })}
                                className={draft.form.mode === mode ? chipOnClass : chipClass}
                            >
                                {t(`board.schedule.mode.${mode}`)}
                            </button>
                        ))}
                    </div>

                    {draft.form.mode === 'minutes' ? (
                        <div className={rowClass}>
                            {t('board.schedule.every')}
                            <MenuSelect
                                ariaLabel={t('board.schedule.unit.minutes')}
                                value={draft.form.everyMinutes}
                                options={MINUTE_STEPS.map((step) => ({ value: step, label: String(step) }))}
                                onChange={(everyMinutes) => setForm({ everyMinutes })}
                            />
                            {t('board.schedule.unit.minutes')}
                        </div>
                    ) : null}

                    {draft.form.mode === 'hours' ? (
                        <div className={rowClass}>
                            {t('board.schedule.every')}
                            <MenuSelect
                                ariaLabel={t('board.schedule.unit.hours')}
                                value={draft.form.everyHours}
                                options={HOUR_STEPS.map((step) => ({ value: step, label: String(step) }))}
                                onChange={(everyHours) => setForm({ everyHours })}
                            />
                            {t('board.schedule.unit.hours')}
                            <span>{t('board.schedule.atMinute')}</span>
                            <MenuSelect
                                ariaLabel={t('board.schedule.atMinute')}
                                value={draft.form.minute}
                                options={MINUTE_OPTIONS}
                                onChange={(minute) => setForm({ minute })}
                            />
                        </div>
                    ) : null}

                    {draft.form.mode === 'weekly' ? (
                        <div className="flex flex-col gap-1.5">
                            <div className="flex flex-wrap gap-1">
                                {WEEKDAY_ORDER.map((day) => {
                                    const on = draft.form.weekdays.includes(day)
                                    return (
                                        <button
                                            key={day}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => setForm({
                                                weekdays: on
                                                    ? draft.form.weekdays.filter((d) => d !== day)
                                                    : [...draft.form.weekdays, day]
                                            })}
                                            className={on ? chipOnClass : chipClass}
                                        >
                                            {t(`board.schedule.weekdayShort.${day}`)}
                                        </button>
                                    )
                                })}
                            </div>
                            <div className="flex gap-3">
                                <button type="button" className={linkClass} onClick={() => setForm({ weekdays: [...WORKDAYS] })}>
                                    {t('board.schedule.days.workdays')}
                                </button>
                                <button type="button" className={linkClass} onClick={() => setForm({ weekdays: [...WEEKEND] })}>
                                    {t('board.schedule.days.weekend')}
                                </button>
                                <button type="button" className={linkClass} onClick={() => setForm({ weekdays: [...ALL_DAYS] })}>
                                    {t('board.schedule.days.all')}
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {draft.form.mode === 'monthly' ? (
                        <div className={rowClass}>
                            {t('board.schedule.monthDay')}
                            <MenuSelect
                                ariaLabel={t('board.schedule.monthDay')}
                                value={String(draft.form.monthDay)}
                                options={[
                                    ...MONTH_DAYS.map((day) => ({ value: String(day), label: t('board.schedule.dayOfMonth', { day: String(day) }) })),
                                    { value: 'last', label: t('board.schedule.lastDay') }
                                ]}
                                onChange={(value) => setForm({ monthDay: value === 'last' ? 'last' : Number(value) })}
                            />
                        </div>
                    ) : null}

                    {draft.form.mode === 'daily' || draft.form.mode === 'weekly' || draft.form.mode === 'monthly' ? (
                        <div className={rowClass}>
                            {t('board.schedule.time')}
                            <TimePickerField
                                ariaLabel={t('board.schedule.time')}
                                hourLabel={t('board.schedule.hour')}
                                minuteLabel={t('board.schedule.minute')}
                                value={draft.form.time}
                                onChange={(time) => setForm({ time })}
                            />
                        </div>
                    ) : null}

                    {draft.form.mode === 'advanced' ? (
                        <div className="flex flex-col gap-1">
                            <input
                                type="text"
                                aria-label={t('board.schedule.cron')}
                                placeholder="0 9 * * 1-5"
                                value={draft.form.cron}
                                onChange={(event) => setForm({ cron: event.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                            <span className="text-xs text-[var(--app-hint)]">{t('board.schedule.cronHint')}</span>
                        </div>
                    ) : null}

                    <div className={rowClass}>
                        {t('board.schedule.timezone')}
                        <MenuSelect
                            ariaLabel={t('board.schedule.timezone')}
                            value={draft.tz}
                            options={zones}
                            onChange={(tz) => setDraft({ ...draft, tz })}
                            searchPlaceholder={t('board.schedule.searchTimezone')}
                            className="min-w-0 flex-1"
                        />
                    </div>

                    <div className="border-y border-[var(--app-border)] py-2 text-xs">
                        {preview.error ? (
                            <span className="text-[var(--app-accent)]">{preview.error}</span>
                        ) : (
                            <>
                                <div className="text-[var(--app-fg)]">
                                    {describeCron(cron, locale)}
                                    {draft.form.mode === 'advanced' ? null : (
                                        <span className="ml-1 font-mono text-[var(--app-hint)]">{cron}</span>
                                    )}
                                </div>
                                <div className="mt-0.5 text-[var(--app-hint)]">
                                    {t('board.schedule.nextRuns')}: {preview.runs.map((run) => formatAt(run, draft.tz, locale)).join(' · ')}
                                </div>
                            </>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-[var(--app-hint)]">{t('board.schedule.sessionMode')}</span>
                        <div className="flex flex-wrap gap-1">
                            {(['fresh', 'continue'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    aria-pressed={draft.sessionMode === mode}
                                    onClick={() => setDraft({ ...draft, sessionMode: mode })}
                                    className={draft.sessionMode === mode ? chipOnClass : chipClass}
                                >
                                    {t(`board.schedule.sessionMode.${mode}`)}
                                </button>
                            ))}
                        </div>
                        <span className="text-xs text-[var(--app-hint)]">{t(`board.schedule.sessionModeHint.${draft.sessionMode}`)}</span>
                    </div>

                    <label className="flex items-center gap-1.5 text-xs text-[var(--app-fg)]">
                        <input
                            type="checkbox"
                            className="accent-[var(--app-fg)]"
                            checked={draft.catchup}
                            onChange={(event) => setDraft({ ...draft, catchup: event.target.checked })}
                        />
                        {t('board.schedule.catchup')}
                    </label>
                    <div className={rowClass}>
                        {t('board.schedule.overlap')}
                        <MenuSelect<TaskScheduleOverlap>
                            ariaLabel={t('board.schedule.overlap')}
                            value={draft.overlap}
                            options={[
                                { value: 'skip', label: t('board.schedule.overlap.skip') },
                                { value: 'queue_one', label: t('board.schedule.overlap.queue_one') }
                            ]}
                            onChange={(overlap) => setDraft({ ...draft, overlap })}
                        />
                    </div>
                    <div className={rowClass}>
                        {t('board.schedule.maxRun')}
                        <MenuSelect
                            ariaLabel={t('board.schedule.maxRun')}
                            value={draft.maxRunMinutes}
                            options={maxRunOptions(draft.maxRunMinutes, t)}
                            onChange={(maxRunMinutes) => setDraft({ ...draft, maxRunMinutes })}
                        />
                    </div>

                    <div className="flex gap-1.5">
                        <button
                            type="button"
                            className={buttonClass}
                            disabled={busy || preview.error !== null}
                            onClick={() => save.mutate()}
                        >
                            {t('board.schedule.save')}
                        </button>
                        <button
                            type="button"
                            className={buttonClass}
                            disabled={busy}
                            onClick={() => { setEditing(false); setErrorText(null) }}
                        >
                            {t('board.schedule.cancel')}
                        </button>
                    </div>
                </div>
            ) : null}

            {errorText ? (
                <p role="alert" className="mt-2 text-[13px] text-[var(--app-accent)]">{errorText}</p>
            ) : null}
        </section>
    )
}

function ScheduleSummary(props: {
    schedule: TaskSchedule
    slots: TaskScheduleSlot[]
    locale: Locale
    busy: boolean
    onEdit: () => void
    onAction: (kind: 'pause' | 'resume' | 'run-now' | 'delete') => void
}) {
    const { t } = useTranslation()
    const { schedule, locale } = props
    const [confirmingDelete, setConfirmingDelete] = useState(false)

    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-xs text-[var(--app-fg)]">
                {describeCron(schedule.cron, locale) ?? schedule.cron}
                <span className="ml-1 text-[var(--app-hint)]">· {schedule.tz} · {t(`board.schedule.sessionMode.${schedule.sessionMode}`)}</span>
            </div>
            <div className="text-xs text-[var(--app-hint)]">
                {schedule.enabled
                    ? t('board.schedule.nextRun', { at: schedule.nextRunAt ? formatAt(schedule.nextRunAt, schedule.tz, locale) : '—' })
                    : pausedLabel(schedule.pausedReason, t)}
            </div>
            <div className="flex flex-wrap gap-1.5">
                <button type="button" className={buttonClass} disabled={props.busy} onClick={() => props.onAction('run-now')}>
                    {t('board.schedule.runNow')}
                </button>
                <button
                    type="button"
                    className={buttonClass}
                    disabled={props.busy}
                    onClick={() => props.onAction(schedule.enabled ? 'pause' : 'resume')}
                >
                    {schedule.enabled ? t('board.schedule.pause') : t('board.schedule.resume')}
                </button>
                <button type="button" className={buttonClass} disabled={props.busy} onClick={props.onEdit}>
                    {t('board.schedule.edit')}
                </button>
                <button
                    type="button"
                    className={confirmingDelete ? dangerClass : buttonClass}
                    disabled={props.busy}
                    onClick={() => {
                        if (!confirmingDelete) {
                            setConfirmingDelete(true)
                            return
                        }
                        setConfirmingDelete(false)
                        props.onAction('delete')
                    }}
                >
                    {confirmingDelete ? t('board.schedule.deleteConfirm') : t('board.schedule.delete')}
                </button>
            </div>

            {props.slots.length > 0 ? (
                <div className="mt-1 flex flex-col gap-0.5">
                    {props.slots.map((slot) => (
                        <div key={slot.id} className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 text-[var(--app-hint)]">{formatAt(slot.scheduledFor, schedule.tz, locale)}</span>
                            <span className={slot.status === 'started' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}>
                                {t(`board.schedule.slot.${slot.status}`)}
                                {slot.trigger !== 'cron' ? ` · ${t(`board.schedule.trigger.${slot.trigger}`)}` : ''}
                            </span>
                            {slot.reason ? (
                                <span className="min-w-0 flex-1 truncate text-[var(--app-hint)]" title={slot.reason}>
                                    {slotReasonLabel(slot.reason, t)}
                                </span>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
