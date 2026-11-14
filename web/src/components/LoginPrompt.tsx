import type { CSSProperties } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { ApiClient } from '@/api/client'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { DugongMark } from '@/components/SidebarHeader'
import { Spinner } from '@/components/Spinner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import type { ServerUrlResult } from '@/hooks/useServerUrl'

type LoginPromptProps = {
    mode?: 'login' | 'bind'
    onLogin?: (token: string) => void
    onBind?: (token: string) => Promise<void>
    baseUrl: string
    serverUrl: string | null
    setServerUrl: (input: string) => ServerUrlResult
    clearServerUrl: () => void
    requireServerUrl?: boolean
    error?: string | null
}

/** The template's spacing: page margin, left column start, the rule, the gap beside it. */
const LAYOUT = {
    '--s1': 'clamp(16px, 2.4vw, 32px)',
    '--s2': 'max(var(--s1), 31vw - 110px)',
    '--s3': 'max(112px, 40vw - 40px)',
    '--s4': 'clamp(10px, 1.1vw, 16px)',
} as CSSProperties

export function LoginPrompt(props: LoginPromptProps) {
    const { t } = useTranslation()
    const isBindMode = props.mode === 'bind'
    const [accessToken, setAccessToken] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [isServerDialogOpen, setIsServerDialogOpen] = useState(false)
    const [serverInput, setServerInput] = useState(props.serverUrl ?? '')
    const [serverError, setServerError] = useState<string | null>(null)
    const formId = useId()

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault()

        const trimmedToken = accessToken.trim()
        if (!trimmedToken) {
            setError(t('login.error.enterToken'))
            return
        }

        if (!isBindMode && props.requireServerUrl && !props.serverUrl) {
            setServerError(t('login.server.required'))
            setIsServerDialogOpen(true)
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            if (isBindMode) {
                if (!props.onBind) {
                    setError(t('login.error.bindingUnavailable'))
                    return
                }
                await props.onBind(trimmedToken)
            } else {
                // Validate token by attempting to authenticate
                const client = new ApiClient('', { baseUrl: props.baseUrl })
                await client.authenticate({ accessToken: trimmedToken })
                // If successful, pass token to parent
                if (!props.onLogin) {
                    setError(t('login.error.loginUnavailable'))
                    return
                }
                props.onLogin(trimmedToken)
            }
        } catch (e) {
            const fallbackMessage = isBindMode ? t('login.error.bindFailed') : t('login.error.authFailed')
            setError(e instanceof Error ? e.message : fallbackMessage)
        } finally {
            setIsLoading(false)
        }
    }, [accessToken, props, t, isBindMode])

    useEffect(() => {
        if (!isServerDialogOpen) {
            return
        }
        setServerInput(props.serverUrl ?? '')
    }, [isServerDialogOpen, props.serverUrl])

    const handleSaveServer = useCallback((e: React.FormEvent) => {
        e.preventDefault()
        const result = props.setServerUrl(serverInput)
        if (!result.ok) {
            setServerError(result.error)
            return
        }
        setServerError(null)
        setServerInput(result.value)
        setIsServerDialogOpen(false)
    }, [props, serverInput])

    const handleClearServer = useCallback(() => {
        props.clearServerUrl()
        setServerInput('')
        setServerError(null)
        setIsServerDialogOpen(false)
    }, [props])

    const handleServerDialogOpenChange = useCallback((open: boolean) => {
        setIsServerDialogOpen(open)
        if (!open) {
            setServerError(null)
        }
    }, [])

    const displayError = error || props.error
    const serverSummary = props.serverUrl ?? `${props.baseUrl} ${t('login.server.default')}`
    const title = isBindMode ? t('login.bind.title') : t('login.title')
    const subtitle = t('login.subtitle')
    const submitLabel = isBindMode ? t('login.bind.submit') : t('login.submit')

    return (
        <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--app-bg)] text-[var(--app-fg)]">
            <div className="relative flex min-h-full flex-col pb-[clamp(28px,6vh,72px)]" style={LAYOUT}>
                {/* The rule everything hangs on; draws itself top to bottom. */}
                <span aria-hidden="true" className="pw-rule-down absolute bottom-0 left-[var(--s3)] top-0 w-px bg-[var(--app-rule)]" />

                {/* Top: mark left of the rule, what dugong is right of it, language at the edge */}
                <div className="relative h-16 shrink-0">
                    <div className="absolute left-[var(--s2)] top-[14px]">
                        <DugongMark />
                    </div>
                    <p className="pw-eyebrow absolute left-[calc(var(--s3)+var(--s4))] right-[calc(var(--s1)+44px)] top-[20px] grid gap-0.5">
                        <span>{t('login.tagline')}</span>
                        <span className="text-[var(--app-hint)]">© {new Date().getFullYear()}</span>
                    </p>
                    <div className="absolute right-[var(--s1)] top-[14px]">
                        <LanguageSwitcher />
                    </div>
                </div>

                <div className="mt-auto pt-10">
                    {/* Label left of the rule */}
                    <p className="pw-eyebrow pw-post-in w-[var(--s3)] pb-3 pl-[var(--s2)] pr-[var(--s4)]" style={{ '--post-from': '44px' } as CSSProperties}>
                        {isBindMode ? title : t('login.badge')}
                    </p>

                    {/* Wordmark hung on the rule: "du" ends just left of it, "gong" starts just right of it */}
                    <h1 aria-label={t('login.title')} className="pw-display whitespace-nowrap text-[clamp(84px,min(15vw,26vh),240px)]">
                        <span className="inline-block w-[calc(var(--s3)-var(--s4))] text-right">
                            <span className="pw-post-in inline-block" style={{ '--post-from': '44px' } as CSSProperties}>du</span>
                        </span>
                        <span className="pw-post-in ml-[calc(var(--s4)*2)] inline-block" style={{ '--post-from': '-44px', '--i': 1 } as CSSProperties}>gong</span>
                    </h1>

                    {/* Form right of the rule */}
                    <div
                        className="pw-post-in ml-[calc(var(--s3)+var(--s4))] mr-[var(--s1)] mt-[clamp(28px,6vh,56px)] max-w-[420px]"
                        style={{ '--post-from': '-44px', '--i': 3 } as CSSProperties}
                    >
                        <form id={formId} onSubmit={handleSubmit} aria-label={subtitle}>
                            <label className="grid gap-1.5">
                                <span className="pw-eyebrow">{t('login.placeholder')}</span>
                                <input
                                    type="password"
                                    value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    autoComplete="current-password"
                                    disabled={isLoading}
                                    className="w-full rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[9px] pt-2 text-[17px] leading-[1.3] text-[var(--app-fg)] disabled:opacity-50"
                                />
                            </label>

                            {displayError && (
                                <div role="alert" className="mt-2 text-[13px] text-[var(--app-accent)]">
                                    {displayError}
                                </div>
                            )}
                        </form>

                        {/* Outside the form: the hub dialog's own form must not bubble into sign-in */}
                        <div className="mt-[clamp(22px,4vh,40px)] flex flex-wrap items-center gap-x-[26px] gap-y-3.5 max-[700px]:flex-col max-[700px]:items-start">
                            <Button type="submit" form={formId} size="lg" disabled={isLoading || !accessToken.trim()} aria-busy={isLoading} className="gap-2">
                                {isLoading ? (
                                    <>
                                        <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                                        {isBindMode ? t('login.bind.submitting') : t('login.submitting')}
                                    </>
                                ) : (
                                    submitLabel
                                )}
                            </Button>

                            {!isBindMode && (
                                <div className="flex flex-wrap items-center gap-x-[22px] gap-y-2 text-sm font-semibold">
                                    <a href="https://github.com/ykz9527/dugong#readme" target="_blank" rel="noopener noreferrer" className="pw-underline">
                                        {t('login.help')}
                                    </a>
                                    <Dialog open={isServerDialogOpen} onOpenChange={handleServerDialogOpenChange}>
                                        <DialogTrigger asChild>
                                            <button type="button" className="pw-underline">
                                                Hub {props.serverUrl ? `${t('login.server.custom')}` : `${t('login.server.default')}`}
                                            </button>
                                        </DialogTrigger>
                                        <DialogContent className="max-w-md">
                                            <DialogHeader>
                                                <DialogTitle>{t('login.server.title')}</DialogTitle>
                                                <DialogDescription>
                                                    {t('login.server.description')}
                                                </DialogDescription>
                                            </DialogHeader>
                                            <form onSubmit={handleSaveServer} className="space-y-5">
                                                <div className="text-xs text-[var(--app-hint)]">
                                                    {t('login.server.current')} {serverSummary}
                                                </div>
                                                <label className="grid gap-1.5">
                                                    <span className="pw-eyebrow">{t('login.server.origin')}</span>
                                                    <input
                                                        type="url"
                                                        value={serverInput}
                                                        onChange={(e) => {
                                                            setServerInput(e.target.value)
                                                            setServerError(null)
                                                        }}
                                                        placeholder={t('login.server.placeholder')}
                                                        className="w-full rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[9px] pt-2 text-[17px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                                    />
                                                    <span className="text-xs text-[var(--app-hint)]">
                                                        {t('login.server.hint')}
                                                    </span>
                                                </label>

                                                {serverError && (
                                                    <div role="alert" className="text-[13px] text-[var(--app-accent)]">
                                                        {serverError}
                                                    </div>
                                                )}

                                                <div className="flex items-center justify-end gap-2">
                                                    {props.serverUrl && (
                                                        <Button type="button" variant="outline" onClick={handleClearServer}>
                                                            {t('login.server.useSameOrigin')}
                                                        </Button>
                                                    )}
                                                    <Button type="submit">
                                                        {t('login.server.save')}
                                                    </Button>
                                                </div>
                                            </form>
                                        </DialogContent>
                                    </Dialog>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
