import { useEffect, useRef, useState } from 'react'
import type { HapiSessionExportTooLarge, HapiSessionExportWarning } from '@hapi/protocol/sessionExport'
import { ApiError, type ApiClient } from '@/api/client'
import {
    downloadSessionExport,
    readSessionExportFormat,
    writeSessionExportFormat,
    type SessionExportFormat
} from '@/lib/sessionExport/download'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'

type SessionExportDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    api: ApiClient | null
}

function formatExportSize(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024
        unitIndex += 1
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function parseSessionExportTooLarge(error: unknown): HapiSessionExportTooLarge | null {
    if (!(error instanceof ApiError) || error.code !== 'session_export_too_large' || !error.body) {
        return null
    }

    try {
        const details = JSON.parse(error.body) as Partial<HapiSessionExportTooLarge>
        if (
            details.type !== 'too-large'
            || typeof details.count !== 'number'
            || typeof details.estimatedBytes !== 'number'
            || typeof details.maxBytes !== 'number'
        ) {
            return null
        }
        return details as HapiSessionExportTooLarge
    } catch {
        return null
    }
}

export function SessionExportDialog(props: SessionExportDialogProps) {
    const { t } = useTranslation()
    const toast = useToast()
    const [format, setFormat] = useState<SessionExportFormat>('json')
    const [isExporting, setIsExporting] = useState(false)
    const [warning, setWarning] = useState<HapiSessionExportWarning | null>(null)
    const [error, setError] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!props.isOpen) return
        setFormat(readSessionExportFormat())
        setWarning(null)
        setError(null)
    }, [props.isOpen])

    useEffect(() => {
        return () => {
            abortRef.current?.abort()
        }
    }, [])

    const handleClose = () => {
        abortRef.current?.abort()
        abortRef.current = null
        setIsExporting(false)
        setWarning(null)
        props.onClose()
    }

    const handleDownload = async () => {
        if (!props.api) {
            setError(t('session.export.error.noApi'))
            return
        }

        setError(null)
        setIsExporting(true)
        writeSessionExportFormat(format)
        const controller = new AbortController()
        abortRef.current = controller

        try {
            const result = await downloadSessionExport(props.api, props.sessionId, format, {
                force: warning !== null,
                signal: controller.signal
            })
            if (result.type === 'warning') {
                setWarning(result.warning)
                return
            }
            if (result.type === 'too-large') {
                setError(t('session.export.error.tooLarge', {
                    count: result.count.toLocaleString(),
                    size: formatExportSize(result.estimatedBytes),
                    maxSize: formatExportSize(result.maxBytes)
                }))
                return
            }
            toast.addToast({
                title: t('session.export.toast.success.title'),
                body: t('session.export.toast.success.body', { filename: result.filename }),
                sessionId: props.sessionId,
                url: `/sessions/${props.sessionId}`
            })
            props.onClose()
        } catch (error) {
            if (controller.signal.aborted) {
                return
            }
            const resourceLimit = parseSessionExportTooLarge(error)
            const message = resourceLimit
                ? t('session.export.error.tooLarge', {
                    count: resourceLimit.count.toLocaleString(),
                    size: formatExportSize(resourceLimit.estimatedBytes),
                    maxSize: formatExportSize(resourceLimit.maxBytes)
                })
                : error instanceof Error && error.message
                    ? error.message
                    : t('session.export.error.default')
            setError(message)
            toast.addToast({
                title: t('session.export.toast.error.title'),
                body: message,
                sessionId: props.sessionId,
                url: `/sessions/${props.sessionId}`
            })
        } finally {
            if (abortRef.current === controller) {
                abortRef.current = null
            }
            if (!controller.signal.aborted) {
                setIsExporting(false)
            }
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('session.export.title')}
                    </DialogTitle>
                    <DialogDescription className="mt-2">
                        {t('session.export.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 border-b border-[var(--app-border)]">
                    <label className="pw-row-fill flex cursor-pointer items-center gap-3 border-t border-[var(--app-border)] px-1 py-3">
                        <input
                            type="radio"
                            name="session-export-format"
                            value="json"
                            checked={format === 'json'}
                            onChange={() => setFormat('json')}
                            disabled={isExporting}
                            className="h-4 w-4 shrink-0 accent-[var(--app-fg)]"
                        />
                        <span>
                            <span className="block text-[15px] font-medium">{t('session.export.format.json')}</span>
                            <span className="block text-[13px] text-[var(--app-hint)]">{t('session.export.format.json.description')}</span>
                        </span>
                    </label>
                    <label className="pw-row-fill flex cursor-pointer items-center gap-3 border-t border-[var(--app-border)] px-1 py-3">
                        <input
                            type="radio"
                            name="session-export-format"
                            value="markdown"
                            checked={format === 'markdown'}
                            onChange={() => setFormat('markdown')}
                            disabled={isExporting}
                            className="h-4 w-4 shrink-0 accent-[var(--app-fg)]"
                        />
                        <span>
                            <span className="block text-[15px] font-medium">{t('session.export.format.markdown')}</span>
                            <span className="block text-[13px] text-[var(--app-hint)]">{t('session.export.format.markdown.description')}</span>
                        </span>
                    </label>
                </div>

                {warning ? (
                    <div role="alert" className="mt-3 text-[13px] text-[var(--app-badge-warning-text)]">
                        <p className="font-semibold">{t('session.export.warning.title')}</p>
                        <p className="mt-1">
                            {t('session.export.warning.description', {
                                count: warning.count.toLocaleString(),
                                size: formatExportSize(warning.estimatedBytes),
                                limit: warning.limit.toLocaleString()
                            })}
                        </p>
                    </div>
                ) : null}

                {error ? (
                    <div role="alert" className="mt-3 text-[13px] text-[var(--app-accent)]">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={handleClose} disabled={isExporting}>
                        {t('button.cancel')}
                    </Button>
                    <Button type="button" onClick={handleDownload} disabled={isExporting}>
                        {isExporting
                            ? t('session.export.downloading')
                            : warning
                                ? t('session.export.downloadAnyway')
                                : t('session.export.download')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
