import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SettingsPageContent, SettingsRow, SettingsSection, settingsFieldClass, settingsFieldLabelClass } from '@/components/settings/SettingsPrimitives'
import { Button } from '@/components/ui/button'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

/**
 * Git forge credentials.
 *
 * Tokens are write-only from here: the hub returns which hosts are configured
 * and a last-four hint, never the value. There is nothing to prefill and
 * nothing to leak back into a browser tab.
 */

const gitHostTokensKey = ['git-host-tokens'] as const

export default function SettingsGitHostPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()

    const [host, setHost] = useState('github.com')
    const [token, setToken] = useState('')

    const query = useQuery({
        queryKey: gitHostTokensKey,
        queryFn: async () => await api.getGitHostTokens(),
    })

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: gitHostTokensKey })
    }

    const save = useMutation({
        mutationFn: async (input: { host: string; token: string }) =>
            await api.putGitHostToken(input.host, input.token),
        onSuccess: () => {
            setToken('')
            invalidate()
        },
    })

    const remove = useMutation({
        mutationFn: async (target: string) => await api.deleteGitHostToken(target),
        onSuccess: invalidate,
    })

    const error = save.error ?? remove.error ?? query.error
    const canSave = host.trim().length > 0 && token.trim().length > 0 && !save.isPending

    return (
        <SettingsPageContent>
            <SettingsSection title={t('settings.gitHost.configured')} description={t('settings.gitHost.description')}>
                {query.data?.tokens.length ? (
                    query.data.tokens.map((entry) => (
                        <SettingsRow
                            key={entry.host}
                            label={entry.host}
                            description={entry.hint}
                            trailing={(
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    disabled={remove.isPending}
                                    onClick={() => { remove.mutate(entry.host) }}
                                >
                                    {t('settings.gitHost.remove')}
                                </Button>
                            )}
                        />
                    ))
                ) : (
                    <SettingsRow
                        label={t('settings.gitHost.none')}
                        description={t('settings.gitHost.noneHint')}
                    />
                )}
            </SettingsSection>

            <SettingsSection
                title={t('settings.gitHost.add')}
                description={t('settings.gitHost.addHint')}
            >
                <div className="pw-ledger flex flex-col gap-5 pb-5 pt-4">
                    <label className="flex flex-col gap-1.5">
                        <span className={settingsFieldLabelClass}>
                            {t('settings.gitHost.host')}
                        </span>
                        <input
                            type="text"
                            value={host}
                            onChange={(event) => setHost(event.target.value)}
                            placeholder="github.com"
                            className={settingsFieldClass}
                        />
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className={settingsFieldLabelClass}>
                            {t('settings.gitHost.token')}
                        </span>
                        <input
                            type="password"
                            value={token}
                            autoComplete="off"
                            onChange={(event) => setToken(event.target.value)}
                            placeholder="ghp_…"
                            className={settingsFieldClass}
                        />
                    </label>

                    {error ? (
                        <p className="text-[13px] text-[var(--app-accent)]">
                            {error instanceof Error ? error.message : t('settings.gitHost.saveFailed')}
                        </p>
                    ) : null}

                    <Button
                        type="button"
                        className="self-start"
                        disabled={!canSave}
                        onClick={() => { save.mutate({ host: host.trim(), token: token.trim() }) }}
                    >
                        {save.isPending ? t('settings.gitHost.saving') : t('settings.gitHost.save')}
                    </Button>
                </div>
            </SettingsSection>
        </SettingsPageContent>
    )
}
