import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export const DUGONG_REPO_URL = 'https://github.com/ykz9527/dugong'

/** How long someone has used dugong before the star invite shows. */
export const STAR_INVITE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The star button in the sidebar header: `☆ Star │ 128`. The count comes from
 * the hub (which asks GitHub); without one the button is just `☆ Star`.
 */
export function GitHubStarButton(props: { api: ApiClient | null; onClick?: () => void; className?: string }) {
    const { t } = useTranslation()
    const { data } = useQuery({
        queryKey: queryKeys.githubStars,
        queryFn: () => props.api!.getGithubStars(),
        enabled: Boolean(props.api),
        staleTime: 60 * 60 * 1000,
        retry: false,
    })
    const stars = data?.stars ?? null

    return (
        <a
            href={DUGONG_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={props.onClick}
            className={`pw-ghost-sweep pw-star-pill h-[26px] shrink-0 items-stretch rounded-full border border-[var(--app-fg)] text-xs font-semibold ${props.className ?? 'flex'}`}
            title={t('sidebar.starOnGithub')}
        >
            <span className="flex items-center gap-1.5 px-2">
                <StarGlyph />
                Star
            </span>
            {stars !== null ? (
                <span className="flex min-w-[26px] items-center justify-center border-l border-current px-2 tabular-nums">
                    <CountUp value={stars} />
                </span>
            ) : null}
        </a>
    )
}

/**
 * The star as a plain header icon, for a sidebar too narrow for the pill.
 */
export function GitHubStarIcon(props: { onClick?: () => void; className?: string }) {
    const { t } = useTranslation()
    return (
        <a
            href={DUGONG_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={props.onClick}
            className={props.className}
            title={t('sidebar.starOnGithub')}
            aria-label={t('sidebar.starOnGithub')}
        >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
                <polygon points={STAR_POINTS} />
            </svg>
        </a>
    )
}

/**
 * One-time invite at the top of the task list, for people who have used
 * dugong a while. Either button retires it for good.
 */
export function StarInvite(props: { onDismiss: () => void }) {
    const { t } = useTranslation()
    return (
        <div className="relative mx-5 mt-3 border border-t-0 border-[var(--app-border)] px-3 py-3">
            <span aria-hidden="true" className="pw-rule-in absolute inset-x-0 top-0 h-px bg-[var(--app-fg)]" />
            <div className="pw-post-in">
                <div className="text-xs font-semibold text-[var(--app-accent)]">{t('sidebar.starInvite.label')}</div>
                <p className="mb-2.5 mt-1 text-sm text-[var(--app-fg)]">{t('sidebar.starInvite.body')}</p>
                <div className="flex items-center gap-3">
                    <a
                        href={DUGONG_REPO_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={props.onDismiss}
                        className="pw-sweep inline-flex h-[30px] items-center rounded-full bg-[var(--app-button)] px-3.5 text-[13px] font-semibold text-[var(--app-button-text)]"
                    >
                        {t('sidebar.starInvite.star')}
                    </a>
                    <button
                        type="button"
                        onClick={props.onDismiss}
                        className="text-xs font-semibold text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    >
                        {t('sidebar.starInvite.dismiss')}
                    </button>
                </div>
            </div>
        </div>
    )
}

/** Earliest task creation time, or null with no tasks. */
export function firstUseAt(tasks: ReadonlyArray<{ createdAt: number }>): number | null {
    let first: number | null = null
    for (const task of tasks) {
        if (first === null || task.createdAt < first) first = task.createdAt
    }
    return first
}

const STAR_POINTS = '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2'

function StarGlyph() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
            <polygon
                points={STAR_POINTS}
                pathLength={64}
            />
        </svg>
    )
}

/** Rolls from 0 to `value` once when it first shows. */
function CountUp(props: { value: number }) {
    const [shown, setShown] = useState(() => (prefersReducedMotion() ? props.value : 0))
    useEffect(() => {
        if (prefersReducedMotion()) {
            setShown(props.value)
            return
        }
        const start = performance.now()
        let frame = 0
        const step = (now: number) => {
            const p = Math.min(1, (now - start) / 900)
            setShown(Math.round(props.value * (1 - Math.pow(1 - p, 3))))
            if (p < 1) frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => cancelAnimationFrame(frame)
    }, [props.value])
    return <>{shown.toLocaleString()}</>
}

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}
