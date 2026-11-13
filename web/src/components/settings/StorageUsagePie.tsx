import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { formatFileSize } from '@/lib/file-metadata'
import {
    buildStorageUsageSlices,
    describeDonutArc,
    formatStoragePercent,
    type StorageUsageBytes,
    type StorageUsageSlice,
    type StorageUsageSliceKey,
} from '@/components/settings/storageUsageSlices'

const SLICE_FILL: Record<StorageUsageSliceKey, string> = {
    database: 'var(--app-link)',
    wal: 'color-mix(in srgb, var(--app-link) 55%, var(--app-hint))',
    shm: 'var(--app-hint)',
}

type Labels = {
    title: string
    empty: string
    database: string
    wal: string
    shm: string
    total: string
    path: string
}

type StorageUsagePieProps = {
    usage: StorageUsageBytes
    totalBytes: number
    path: string
    labels: Labels
}

function labelFor(key: StorageUsageSliceKey, labels: Labels): string {
    return labels[key]
}

export function StorageUsagePie(props: StorageUsagePieProps) {
    const { usage, totalBytes, path, labels } = props
    const chartId = useId()
    const slices = useMemo(() => buildStorageUsageSlices(usage), [usage])
    const [activeKey, setActiveKey] = useState<StorageUsageSliceKey | null>(null)

    const active = useMemo(() => {
        if (slices.length === 0) return null
        return slices.find((slice) => slice.key === activeKey) ?? slices[0] ?? null
    }, [activeKey, slices])

    const totalLabel = formatFileSize(totalBytes) ?? '0 B'

    if (slices.length === 0) {
        return (
            <section>
                <h3 className="pw-eyebrow mb-2 text-[var(--app-hint)]">{labels.title}</h3>
                <div className="pw-ledger py-3 text-[15px] text-[var(--app-hint)]">{labels.empty}</div>
                <TotalFooter label={labels.total} value={totalLabel} className="pw-ledger py-3" />
                <PathFooter label={labels.path} path={path} />
            </section>
        )
    }

    const size = 220
    const cx = size / 2
    const cy = size / 2
    const innerRadius = 58
    const outerRadius = 88
    const activeOuterRadius = 96

    const onLegendKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: StorageUsageSliceKey) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return
        }
        event.preventDefault()
        const index = slices.findIndex((slice) => slice.key === key)
        if (index < 0) return
        const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
        const next = slices[(index + delta + slices.length) % slices.length]
        if (!next) return
        setActiveKey(next.key)
        const nextButton = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-slice-key="${next.key}"]`)
        nextButton?.focus()
    }

    return (
        <section>
            <h3 className="pw-eyebrow mb-2 text-[var(--app-hint)]">{labels.title}</h3>
            <div className="flex flex-col items-center gap-6 border-t border-[var(--app-border)] pt-6 sm:flex-row sm:items-center sm:gap-10">
                <div className="relative shrink-0" style={{ width: size, height: size }}>
                    <svg
                        viewBox={`0 0 ${size} ${size}`}
                        width={size}
                        height={size}
                        role="img"
                        aria-labelledby={`${chartId}-title ${chartId}-desc`}
                        className="select-none"
                    >
                        <title id={`${chartId}-title`}>{labels.title}</title>
                        <desc id={`${chartId}-desc`}>
                            {slices
                                .map((slice) => `${labelFor(slice.key, labels)} ${formatStoragePercent(slice.percent)}`)
                                .join(', ')}
                        </desc>
                        {slices.map((slice) => {
                            const isActive = active?.key === slice.key
                            const pathD = describeDonutArc(
                                cx,
                                cy,
                                innerRadius,
                                isActive ? activeOuterRadius : outerRadius,
                                slice.startAngle,
                                slice.endAngle,
                            )
                            return (
                                <path
                                    key={slice.key}
                                    d={pathD}
                                    fill={SLICE_FILL[slice.key]}
                                    opacity={isActive ? 1 : 0.82}
                                    className="cursor-pointer transition-[opacity] duration-300"
                                    onPointerEnter={() => setActiveKey(slice.key)}
                                    onFocus={() => setActiveKey(slice.key)}
                                    onClick={() => setActiveKey(slice.key)}
                                    tabIndex={-1}
                                    aria-hidden="true"
                                />
                            )
                        })}
                    </svg>
                    {active ? <CenterReadout slice={active} labels={labels} /> : null}
                </div>

                <div className="flex w-full min-w-0 flex-1 flex-col">
                    <div className="flex flex-col" role="listbox" aria-label={labels.title}>
                        {slices.map((slice) => {
                            const isActive = active?.key === slice.key
                            const sizeLabel = formatFileSize(slice.bytes) ?? '0 B'
                            return (
                                <button
                                    key={slice.key}
                                    id={`${chartId}-${slice.key}`}
                                    type="button"
                                    role="option"
                                    aria-selected={isActive}
                                    tabIndex={isActive ? 0 : -1}
                                    data-slice-key={slice.key}
                                    data-testid={`storage-pie-legend-${slice.key}`}
                                    onClick={() => setActiveKey(slice.key)}
                                    onPointerEnter={() => setActiveKey(slice.key)}
                                    onFocus={() => setActiveKey(slice.key)}
                                    onKeyDown={(event) => onLegendKeyDown(event, slice.key)}
                                    className={`pw-ledger flex min-h-11 items-center gap-3 py-2.5 text-left text-[15px] transition-colors duration-300 ${
                                        isActive
                                            ? 'text-[var(--app-fg)]'
                                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                    }`}
                                >
                                    <span
                                        className="h-2 w-2 shrink-0 rounded-full"
                                        style={{ background: SLICE_FILL[slice.key] }}
                                        aria-hidden="true"
                                    />
                                    <span className={`min-w-0 flex-1 truncate ${isActive ? 'font-medium' : ''}`}>{labelFor(slice.key, labels)}</span>
                                    <span className="shrink-0 tabular-nums">{sizeLabel}</span>
                                    <span className="w-12 shrink-0 text-right tabular-nums">{formatStoragePercent(slice.percent)}</span>
                                </button>
                            )
                        })}
                    </div>
                    <TotalFooter label={labels.total} value={totalLabel} className="border-t border-[var(--app-rule)] py-2.5" />
                </div>
            </div>
            <PathFooter label={labels.path} path={path} />
        </section>
    )
}

function TotalFooter(props: { label: string; value: string; className?: string }) {
    return (
        <div
            className={`flex items-center justify-between gap-2 text-[15px] ${props.className ?? ''}`}
            data-testid="storage-pie-total"
        >
            <span className="font-medium text-[var(--app-fg)]">{props.label}</span>
            <span className="tabular-nums font-medium text-[var(--app-fg)]">{props.value}</span>
        </div>
    )
}

function PathFooter(props: { label: string; path: string }) {
    return (
        <div className="mt-6 border-y border-[var(--app-border)] py-3" data-testid="storage-pie-path">
            <div className="pw-eyebrow text-[var(--app-hint)]">{props.label}</div>
            <code className="mt-1 block truncate text-[13px] text-[var(--app-fg)]" title={props.path}>
                {props.path}
            </code>
        </div>
    )
}

function CenterReadout(props: { slice: StorageUsageSlice; labels: Labels }) {
    const sizeLabel = formatFileSize(props.slice.bytes) ?? '0 B'
    return (
        <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
            data-testid="storage-pie-center"
        >
            <div className="pw-eyebrow text-[var(--app-hint)]">{labelFor(props.slice.key, props.labels)}</div>
            <div className="mt-0.5 text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">{sizeLabel}</div>
            <div className="text-[13px] tabular-nums text-[var(--app-hint)]">{formatStoragePercent(props.slice.percent)}</div>
        </div>
    )
}
