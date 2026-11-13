import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function getReasonLabel(reason: string, t: (key: string) => string): string {
    if (reason === 'heartbeat-timeout') {
        return t('reconnecting.reason.heartbeatTimeout')
    }
    if (reason === 'visibility-recovery') {
        return t('reconnecting.reason.visibilityRecovery')
    }
    if (reason === 'connect-timeout') {
        return t('reconnecting.reason.connectTimeout')
    }
    if (reason === 'transport-error') {
        return t('reconnecting.reason.transportError')
    }
    if (reason === 'closed') {
        return t('reconnecting.reason.closed')
    }
    if (reason === 'error') {
        return t('reconnecting.reason.error')
    }
    return reason
}

export function ReconnectingBanner({
    isReconnecting,
    reason
}: {
    isReconnecting: boolean
    reason?: string | null
}) {
    const { t } = useTranslation()
    const reasonLabel = reason ? getReasonLabel(reason, t) : null

    if (!isReconnecting) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 border-b border-[var(--app-rule)] bg-[var(--app-banner-bg)] pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-[13px] font-medium leading-5 text-[var(--app-banner-text)]">
            <Spinner size="sm" label={null} className="text-[var(--app-banner-text)]" />
            {t('reconnecting.message')}
            {reasonLabel ? <span className="opacity-60">({reasonLabel})</span> : null}
        </div>
    )
}
