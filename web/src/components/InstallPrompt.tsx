import { useEffect, useState } from 'react'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { usePlatform } from '@/hooks/usePlatform'
import { CloseIcon, ShareIcon, PlusCircleIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export function InstallPrompt() {
    const { t } = useTranslation()
    const { canInstall, canInstallIOS, promptInstall, dismissInstall, isStandalone } = usePWAInstall()
    const { isTelegram, haptic } = usePlatform()
    const [showIOSGuide, setShowIOSGuide] = useState(false)
    const showFloatingPrompt = !isTelegram && !isStandalone && ((canInstallIOS && !showIOSGuide) || canInstall)

    useEffect(() => {
        const root = document.documentElement
        if (!root) return

        if (showFloatingPrompt) {
            root.style.setProperty('--app-floating-bottom-offset', '112px')
        } else {
            root.style.removeProperty('--app-floating-bottom-offset')
        }

        return () => {
            root.style.removeProperty('--app-floating-bottom-offset')
        }
    }, [showFloatingPrompt])

    if (isTelegram || isStandalone) {
        return null
    }

    // iOS Safari install guide
    if (canInstallIOS) {
        if (showIOSGuide) {
            return (
                <div className="pw-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40" data-state="open">
                    <div className="pw-sheet-in w-full max-w-lg space-y-4 border-t border-[var(--app-rule)] bg-[var(--app-bg)] p-5 pb-8">
                        <div className="flex items-center justify-between">
                            <h3 className="text-[17px] font-medium tracking-[-0.02em] text-[var(--app-fg)]">
                                {t('install.title')}
                            </h3>
                            <button
                                onClick={() => setShowIOSGuide(false)}
                                className="pw-ghost-sweep -mr-1 flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)]"
                                aria-label="Close"
                            >
                                <CloseIcon className="w-5 h-5" />
                            </button>
                        </div>

                        <ol>
                            <li className="pw-ledger flex items-baseline gap-3 py-2.5">
                                <div className="pw-eyebrow w-4 shrink-0 text-[var(--app-hint)]">
                                    1
                                </div>
                                <div className="flex-1">
                                    <p className="text-[15px] text-[var(--app-fg)]">
                                        Tap the <ShareIcon className="inline w-5 h-5 align-text-bottom" /> Share button in the toolbar
                                    </p>
                                </div>
                            </li>

                            <li className="pw-ledger flex items-baseline gap-3 py-2.5">
                                <div className="pw-eyebrow w-4 shrink-0 text-[var(--app-hint)]">
                                    2
                                </div>
                                <div className="flex-1">
                                    <p className="text-[15px] text-[var(--app-fg)]">
                                        Scroll down and tap <PlusCircleIcon className="inline w-5 h-5 align-text-bottom" /> <strong>Add to Home Screen</strong>
                                    </p>
                                </div>
                            </li>

                            <li className="pw-ledger flex items-baseline gap-3 py-2.5">
                                <div className="pw-eyebrow w-4 shrink-0 text-[var(--app-hint)]">
                                    3
                                </div>
                                <div className="flex-1">
                                    <p className="text-[15px] text-[var(--app-fg)]">
                                        Tap <strong>Add</strong> in the top right corner
                                    </p>
                                </div>
                            </li>
                        </ol>

                        <button
                            onClick={() => {
                                setShowIOSGuide(false)
                                dismissInstall()
                            }}
                            className="w-full py-3 text-sm font-semibold text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-fg)]"
                        >
                            {t('button.dismiss')}
                        </button>
                    </div>
                </div>
            )
        }

        return (
            <div className="pw-sheet-in fixed bottom-4 left-4 right-4 z-50 border border-[var(--app-rule)] bg-[var(--app-bg)] p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-medium text-[var(--app-fg)]">
                            {t('install.title')}
                        </p>
                        <p className="text-xs text-[var(--app-hint)] mt-0.5">
                            {t('install.description')}
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            setShowIOSGuide(true)
                        }}
                        className="pw-sweep shrink-0 rounded-full bg-[var(--app-button)] px-4 py-2 text-sm font-semibold text-[var(--app-button-text)]"
                    >
                        {t('install.button')}
                    </button>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            dismissInstall()
                        }}
                        className="pw-ghost-sweep flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)]"
                        aria-label="Dismiss"
                    >
                        <CloseIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
        )
    }

    // Chrome/Edge install prompt
    if (!canInstall) {
        return null
    }

    const handleInstall = async () => {
        haptic.impact('light')
        const success = await promptInstall()
        if (success) {
            haptic.notification('success')
        }
    }

    return (
        <div className="pw-sheet-in fixed bottom-4 left-4 right-4 z-50 border border-[var(--app-rule)] bg-[var(--app-bg)] p-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-medium text-[var(--app-fg)]">
                        {t('install.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t('install.description')}
                    </p>
                </div>
                <button
                    onClick={handleInstall}
                    className="pw-sweep shrink-0 rounded-full bg-[var(--app-button)] px-4 py-2 text-sm font-semibold text-[var(--app-button-text)]"
                >
                    {t('install.button')}
                </button>
                <button
                    onClick={() => {
                        haptic.impact('light')
                        dismissInstall()
                    }}
                    className="pw-ghost-sweep flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)]"
                    aria-label="Dismiss"
                >
                    <CloseIcon className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}
