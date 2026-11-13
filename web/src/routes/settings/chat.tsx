import { useTranslation } from '@/lib/use-translation'
import { getComposerEnterBehaviorOptions, useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { getTerminalToolDisplayModeOptions, useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useCodexExplorationCollapse } from '@/hooks/useCodexExplorationCollapse'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import {
    getChatSurfaceColorPickerValue,
    getChatSurfaceColorPresetOptions,
    toCustomChatSurfaceColorPreference,
    toPresetChatSurfaceColorPreference,
    useChatSurfaceColors,
    type ChatSurfaceColorPreference,
    type ChatSurfaceColorPreset,
} from '@/hooks/useChatSurfaceColors'
import { SettingsChoiceGroup, SettingsFieldLabel, SettingsPageContent, SettingsSection, SettingsSwitch, settingsColorInputClass, settingsRowClass, settingsSwatchClass } from '@/components/settings/SettingsPrimitives'
import { ComposerToolbarLayoutControl } from '@/components/settings/ComposerToolbarLayoutControl'

function ChatSurfaceColorControl(props: {
    label: string
    preference: ChatSurfaceColorPreference
    onPresetChange: (preset: ChatSurfaceColorPreset) => void
    onCustomChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const pickerValue = getChatSurfaceColorPickerValue(props.preference)
    return (
        <div className={`space-y-4 ${settingsRowClass}`}>
            <SettingsFieldLabel>{props.label}</SettingsFieldLabel>
            <div role="radiogroup" aria-label={props.label} className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {getChatSurfaceColorPresetOptions().map((option) => {
                    const preference = toPresetChatSurfaceColorPreference(option.value)
                    const selected = props.preference === preference
                    return (
                        <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => props.onPresetChange(option.value)} className="group flex min-w-0 items-center gap-3 text-left">
                            <span className={settingsSwatchClass(selected)} style={{ backgroundColor: getChatSurfaceColorPickerValue(preference) }} aria-hidden="true" />
                            <span className={`truncate text-[15px] text-[var(--app-fg)] ${selected ? 'font-medium' : ''}`}>{t(option.labelKey)}</span>
                        </button>
                    )
                })}
            </div>
            <label className="flex items-center justify-between gap-3 text-[13px] text-[var(--app-hint)]">
                {t('settings.chat.surfaceColor.custom')}
                <input type="color" value={pickerValue} onChange={(event) => props.onCustomChange(event.target.value)} className={settingsColorInputClass} />
            </label>
        </div>
    )
}

export default function SettingsChatPage() {
    const { t } = useTranslation()
    const { composerEnterBehavior, setComposerEnterBehavior } = useComposerEnterBehavior()
    const { terminalToolDisplayMode, setTerminalToolDisplayMode } = useTerminalToolDisplayMode()
    const { codexExplorationCollapsed, setCodexExplorationCollapsed } = useCodexExplorationCollapse()
    const { reasoningCollapsed, setReasoningCollapsed } = useReasoningCollapse()
    const { toolGroupBackground, userMessageBackground, setToolGroupBackground, setUserMessageBackground } = useChatSurfaceColors()
    return (
        <SettingsPageContent>
            <SettingsSection title={t('settings.chat.input')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.enterBehavior')}
                    value={composerEnterBehavior}
                    options={getComposerEnterBehaviorOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setComposerEnterBehavior}
                />
                <ComposerToolbarLayoutControl />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.tools')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.terminalToolDisplay')}
                    value={terminalToolDisplayMode}
                    options={getTerminalToolDisplayModeOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setTerminalToolDisplayMode}
                />
                <SettingsSwitch
                    label={t('settings.chat.codexExplorationCollapsed')}
                    description={t('settings.chat.codexExplorationCollapsed.desc')}
                    checked={codexExplorationCollapsed}
                    onChange={setCodexExplorationCollapsed}
                />
                <SettingsSwitch
                    label={t('settings.chat.reasoningCollapsed')}
                    description={t('settings.chat.reasoningCollapsed.desc')}
                    checked={reasoningCollapsed}
                    onChange={setReasoningCollapsed}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.colors')}>
                <ChatSurfaceColorControl label={t('settings.chat.groupedToolBackground')} preference={toolGroupBackground} onPresetChange={(preset) => setToolGroupBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setToolGroupBackground(toCustomChatSurfaceColorPreference(value))} />
                <ChatSurfaceColorControl label={t('settings.chat.userMessageBackground')} preference={userMessageBackground} onPresetChange={(preset) => setUserMessageBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setUserMessageBackground(toCustomChatSurfaceColorPreference(value))} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
