import { useCallback, useEffect, useState } from 'react'
import { isMachineCapabilitySkewed, cliBinaryUpdatedOnDisk } from '@hapi/protocol/runnerCapabilities'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import {
    clearRunnerSkewTempDismiss,
    getRunnerSkewDismissUntil,
    isRunnerSkewMinimized,
    isRunnerSkewTempDismissed,
    setRunnerSkewMinimized,
    tempDismissRunnerSkew,
} from '@/lib/runnerSkewBannerState'

export function machineDisplayHost(machine: Machine): string {
    return machine.metadata?.displayName
        ?? machine.metadata?.host
        ?? machine.id
}

export function listSkewedMachines(machines: Machine[]): Machine[] {
    return machines.filter((machine) => (
        machine.active
        && isMachineCapabilitySkewed(machine.metadata?.capabilities)
    ))
}

/**
 * Compact, minimizable skew banner (#1084 dogfood).
 * Temp-dismiss (1h, sessionStorage) or minimize so sessions stay clickable.
 * Manual Restart asks hub to stop-runner (escape hatch when version handoff
 * is stuck or DUGONG_DISABLE_VERSION_HANDOFF=1). Normal upgrades self-restart.
 */
export function RunnerVersionSkewBanner({ topClassName }: { topClassName?: string } = {}) {
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()
    const skewed = listSkewedMachines(machines)
    const [minimized, setMinimized] = useState(() => isRunnerSkewMinimized())
    const [dismissed, setDismissed] = useState(() => isRunnerSkewTempDismissed())
    const [restartingId, setRestartingId] = useState<string | null>(null)
    const [restartError, setRestartError] = useState<string | null>(null)

    useEffect(() => {
        if (!dismissed) {
            return
        }
        const remaining = Math.max(0, getRunnerSkewDismissUntil() - Date.now())
        if (remaining === 0) {
            clearRunnerSkewTempDismiss()
            setDismissed(false)
            return
        }
        const timer = window.setTimeout(() => {
            clearRunnerSkewTempDismiss()
            setDismissed(false)
        }, remaining)
        return () => window.clearTimeout(timer)
    }, [dismissed])

    const onMinimize = useCallback(() => {
        haptic.impact('light')
        // UI first — storage may throw QuotaExceededError on full sessionStorage.
        setMinimized(true)
        setRunnerSkewMinimized(true)
    }, [haptic])

    const onExpand = useCallback(() => {
        haptic.impact('light')
        setMinimized(false)
        setRunnerSkewMinimized(false)
    }, [haptic])

    const onTempDismiss = useCallback(() => {
        haptic.impact('light')
        setDismissed(true)
        tempDismissRunnerSkew()
    }, [haptic])

    const onRestart = useCallback(async (machine: Machine) => {
        if (!api) {
            return
        }
        haptic.impact('medium')
        setRestartError(null)
        setRestartingId(machine.id)
        try {
            await api.restartMachineRunner(machine.id)
        } catch (error) {
            setRestartError(error instanceof Error ? error.message : t('runner.skew.restartFailed'))
        } finally {
            setRestartingId(null)
        }
    }, [api, haptic, t])

    if (skewed.length === 0 || dismissed) {
        return null
    }

    const topClass = topClassName ?? (isOnline ? 'top-2' : 'top-10')
    const hosts = skewed.map(machineDisplayHost).join(', ')

    if (minimized) {
        return (
            <div
                data-testid="runner-version-skew-banner"
                data-state="minimized"
                className={`fixed left-4 right-4 z-40 ${topClass}`}
            >
                <button
                    type="button"
                    data-testid="runner-version-skew-expand"
                    onClick={onExpand}
                    className="pw-row-fill flex w-full items-center gap-2 border border-[var(--app-rule)] bg-[var(--app-bg)] px-3 py-1.5 text-left text-xs font-semibold text-[var(--app-fg)]"
                >
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-warning-text)]" />
                    <span className="min-w-0 truncate">{t('runner.skew.banner.minimized', { count: skewed.length, hosts })}</span>
                </button>
            </div>
        )
    }

    return (
        <div
            data-testid="runner-version-skew-banner"
            data-state="expanded"
            role="alert"
            className={`fixed left-4 right-4 z-40 max-h-[40vh] overflow-y-auto border border-[var(--app-rule)] bg-[var(--app-bg)] px-4 py-3 ${topClass}`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[var(--app-badge-warning-text)]">
                        {t('runner.skew.banner.summaryTitle', { count: skewed.length })}
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed text-[var(--app-hint)]">
                        {t('runner.skew.banner.summaryBody')}
                    </p>
                </div>
                <div className="flex shrink-0 gap-3 pt-0.5">
                    <button
                        type="button"
                        data-testid="runner-version-skew-minimize"
                        onClick={onMinimize}
                        className="pw-underline text-xs font-semibold text-[var(--app-fg)]"
                    >
                        {t('runner.skew.banner.minimize')}
                    </button>
                    <button
                        type="button"
                        data-testid="runner-version-skew-dismiss"
                        onClick={onTempDismiss}
                        className="pw-underline text-xs font-semibold text-[var(--app-fg)]"
                    >
                        {t('runner.skew.banner.dismissTemp')}
                    </button>
                </div>
            </div>

            <ul className="mt-3 border-b border-[var(--app-border)]">
                {skewed.map((machine) => {
                    const host = machineDisplayHost(machine)
                    const version = machine.metadata?.happyCliVersion
                    const newerOnDisk = cliBinaryUpdatedOnDisk(machine.metadata)
                    const supervised = machine.metadata?.supervisedRestart === true
                    const canRestart = newerOnDisk && supervised
                    const restartBusy = restartingId === machine.id
                    const restartTitle = !newerOnDisk
                        ? t('runner.skew.banner.restartNeedsNewerBinary')
                        : !supervised
                            ? t('runner.skew.banner.restartNeedsSupervisor')
                            : undefined
                    return (
                        <li
                            key={machine.id}
                            className="pw-ledger py-2"
                            data-testid={`runner-version-skew-banner-${machine.id}`}
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 text-[13px] text-[var(--app-fg)]">
                                    <span className="font-medium">{host}</span>
                                    {version ? ` · CLI ${version}` : null}
                                    {newerOnDisk ? (
                                        <span className="ml-1 text-[var(--app-hint)]">
                                            {t('runner.skew.banner.binaryUpdatedHint')}
                                        </span>
                                    ) : (
                                        <span className="ml-1 text-[var(--app-badge-warning-text)]">
                                            {t('runner.skew.banner.upgradeCliFirst')}
                                        </span>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    data-testid={`runner-version-skew-restart-${machine.id}`}
                                    disabled={!canRestart || restartBusy}
                                    title={restartTitle}
                                    onClick={() => void onRestart(machine)}
                                    className="pw-ghost-sweep h-7 shrink-0 rounded-full border border-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-fg)] disabled:border-[var(--app-border)] disabled:text-[var(--app-hint)]"
                                >
                                    {restartBusy
                                        ? t('runner.skew.banner.restarting')
                                        : canRestart
                                            ? t('runner.skew.banner.restart')
                                            : t('runner.skew.banner.restartUnavailable')}
                                </button>
                            </div>
                        </li>
                    )
                })}
            </ul>

            {restartError ? (
                <p className="mt-2 text-[13px] text-[var(--app-accent)]" data-testid="runner-version-skew-restart-error">
                    {restartError}
                </p>
            ) : null}

            <p className="mt-2 text-xs leading-relaxed text-[var(--app-hint)]">
                {t('runner.skew.banner.handoffHint')}
            </p>
        </div>
    )
}
