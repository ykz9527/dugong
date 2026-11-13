import { useState } from 'react'
import { SelectControl } from '@/components/ui/select-control'
import {
    DEFAULT_VOICE_CHARACTER,
    DEFAULT_VOICE_IDENTITY,
    ELEVENLABS_WEBRTC_MAX_MESSAGE_BYTES,
    ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES,
    VOICE_CHARACTER_MAX_LENGTH,
    VOICE_IDENTITY_MAX_LENGTH,
    VOICE_PERSONALITY_PRESETS,
    RESPONSE_LENGTH_OPTIONS,
    getPresetDeliverySnippet,
    getVoicePlatformFixturesPreview,
    getVoicePersonalityPreset,
    getVoiceWireBudgetHint,
    isDefaultVoicePersonality,
    resolveComposedVoiceSystemPrompt,
    type VoiceBackendKind,
    type VoicePersonalityPresetId,
    type ResponseLengthOption
} from '@hapi/protocol/voice-personality'
import { readVoiceContextNotice } from '@/lib/voiceContextStream'
import { useVoicePersonality } from '@/hooks/useVoicePersonality'
import { useMemo } from 'react'
import { SwitchControl, settingsFieldLabelClass, settingsPillClass, settingsRowClass, settingsSelectClass } from './SettingsPrimitives'

type Translate = (key: string) => string

function VoiceSlider(props: {
    label: string
    hint?: string
    value: number
    min: number
    max: number
    step: number
    onChange: (value: number) => void
    formatValue?: (value: number) => string
}) {
    const display = props.formatValue ? props.formatValue(props.value) : props.value.toFixed(2)
    return (
        <label className="block py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[15px] text-[var(--app-fg)]">{props.label}</span>
                <span className="text-[13px] tabular-nums text-[var(--app-hint)]">{display}</span>
            </div>
            {props.hint && <p className="mb-2 text-[13px] leading-snug text-[var(--app-hint)]">{props.hint}</p>}
            <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
                onChange={(e) => props.onChange(Number(e.target.value))}
                className="w-full accent-[var(--app-fg)]" />
        </label>
    )
}

/** "How it behaves" — response length selector. */
export function VoiceRespondsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs, setResponseLength } = useVoicePersonality()
    const currentResponseLength: ResponseLengthOption = prefs.responseLength ?? 'balanced'

    return (
        <div className={settingsRowClass}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.responseLength.label')}</p>
            <div className="flex flex-wrap gap-2 sm:justify-end">
                {RESPONSE_LENGTH_OPTIONS.map((opt) => (
                    <button key={opt} type="button" onClick={() => setResponseLength(opt)}
                        aria-pressed={currentResponseLength === opt}
                        className={settingsPillClass(currentResponseLength === opt)}>
                        {props.t(`settings.voice.responseLength.${opt}`)}
                    </button>
                ))}
            </div>
            </div>
            <p className="mt-2 text-[13px] leading-snug text-[var(--app-hint)]">
                {props.t(`settings.voice.responseLength.${currentResponseLength}.hint`)}
            </p>
        </div>
    )
}

/** "Persona & instructions" — identity, character, and speaking style preset. */
export function VoicePersonaControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const {
        prefs,
        setPreset,
        setIdentity,
        setCharacter,
        resetIdentity,
        resetCharacter,
        resetVoicePersonalityLayers,
        appendPresetDeliveryToCharacter,
    } = useVoicePersonality()
    const [identityOpen, setIdentityOpen] = useState(false)
    const [characterOpen, setCharacterOpen] = useState(false)
    const [deliveryOpen, setDeliveryOpen] = useState(false)

    const identityEditor = prefs.identity.trim() || DEFAULT_VOICE_IDENTITY
    const characterEditor = prefs.character.trim() || DEFAULT_VOICE_CHARACTER
    const usingDefaults = isDefaultVoicePersonality(prefs)
    const presetSnippet = getPresetDeliverySnippet(prefs.preset)

    return (
        <div>
            {/* Identity */}
            <button type="button" onClick={() => setIdentityOpen((v) => !v)}
                className={`group flex min-h-12 w-full items-center justify-between gap-4 text-left ${settingsRowClass}`}
                aria-expanded={identityOpen}>
                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.identity.title')}</span>
                <span className="pw-plus text-[var(--app-fg)]" data-open={identityOpen || undefined} aria-hidden="true" />
            </button>
            {identityOpen && (
                <div className="space-y-3 pb-4">
                    <p className="text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.identity.hint')}</p>
                    <textarea value={identityEditor}
                        onChange={(e) => setIdentity(e.target.value === DEFAULT_VOICE_IDENTITY ? '' : e.target.value)}
                        rows={6} maxLength={VOICE_IDENTITY_MAX_LENGTH} spellCheck={false}
                        className="w-full resize-y border border-[var(--app-border)] bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-[var(--app-fg)] outline-none transition-colors duration-300 focus:border-[var(--app-fg)]" />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <span className="text-[13px] text-[var(--app-hint)]">
                            {prefs.identity.trim() ? props.t('settings.voice.identity.customized') : props.t('settings.voice.identity.default')}
                        </span>
                        <button type="button" onClick={resetIdentity}
                            className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold">
                            {props.t('settings.voice.identity.reset')}
                        </button>
                    </div>
                </div>
            )}

            {/* Character & speaking style */}
            <button type="button" onClick={() => setCharacterOpen((v) => !v)}
                className={`group flex min-h-12 w-full items-center justify-between gap-4 text-left ${settingsRowClass}`}
                aria-expanded={characterOpen}>
                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.character.promptTitle')}</span>
                <span className="pw-plus text-[var(--app-fg)]" data-open={characterOpen || undefined} aria-hidden="true" />
            </button>
            {characterOpen && (
                <div className="space-y-3 pb-4">
                    <p className="text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.character.promptHint')}</p>
                    <textarea value={characterEditor}
                        onChange={(e) => setCharacter(e.target.value === DEFAULT_VOICE_CHARACTER ? '' : e.target.value)}
                        rows={8} maxLength={VOICE_CHARACTER_MAX_LENGTH} spellCheck={false}
                        className="w-full resize-y border border-[var(--app-border)] bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-[var(--app-fg)] outline-none transition-colors duration-300 focus:border-[var(--app-fg)]" />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <button type="button" onClick={resetCharacter}
                            className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold">
                            {props.t('settings.voice.character.reset')}
                        </button>
                        {presetSnippet && (
                            <button type="button" onClick={appendPresetDeliveryToCharacter}
                                className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold">
                                {props.t('settings.voice.character.appendPreset')}
                            </button>
                        )}
                        <button type="button" onClick={resetVoicePersonalityLayers}
                            className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold">
                            {props.t('settings.voice.layers.resetAll')}
                        </button>
                    </div>
                </div>
            )}

            {/* Speaking style preset */}
            <button type="button" onClick={() => setDeliveryOpen((v) => !v)}
                className={`group flex min-h-12 w-full items-center justify-between gap-4 text-left ${settingsRowClass}`}
                aria-expanded={deliveryOpen}>
                <span className="flex items-center gap-3 text-[15px] text-[var(--app-fg)]">
                    {props.t('settings.voice.character.title')}
                    {!usingDefaults && (
                        <span className="pw-eyebrow text-[var(--app-hint)]">
                            {props.t('settings.voice.advanced.customizedBadge')}
                        </span>
                    )}
                </span>
                <span className="pw-plus text-[var(--app-fg)]" data-open={deliveryOpen || undefined} aria-hidden="true" />
            </button>
            {deliveryOpen && (
                <div className="space-y-3 pb-4">
                    <p className="text-[13px] leading-snug text-[var(--app-hint)]">
                        {props.t('settings.voice.character.presetSlidersHint')}
                    </p>
                    <label className="block">
                        <span className={`mb-1.5 block ${settingsFieldLabelClass}`}>
                            {props.t('settings.voice.character.preset.label')}
                        </span>
                        <SelectControl value={prefs.preset}
                            onChange={(e) => setPreset(e.target.value as VoicePersonalityPresetId)}
                            className={settingsSelectClass}>
                            {VOICE_PERSONALITY_PRESETS.map((preset) => (
                                <option key={preset.id} value={preset.id}>{props.t(preset.labelKey)}</option>
                            ))}
                        </SelectControl>
                        <p className="mt-1.5 text-[13px] leading-snug text-[var(--app-hint)]">
                            {props.t(getVoicePersonalityPreset(prefs.preset).descriptionKey)}
                        </p>
                        {!usingDefaults && (
                            <p className="mt-2 text-[13px] leading-snug text-[var(--app-hint)]">
                                {props.t('settings.voice.layers.composedNote')}
                            </p>
                        )}
                    </label>
                </div>
            )}
        </div>
    )
}

/** "How it sounds" — per-backend acoustic tuning. Shows a capability note for backends with no sliders. */
export function VoiceSoundsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs, setElevenLabs, setGeminiAffectiveDialog } = useVoicePersonality()
    const [tuningOpen, setTuningOpen] = useState(false)

    const backend = props.voiceBackend ?? 'elevenlabs'
    const showElevenLabsSliders = backend === 'elevenlabs'
    const showGeminiOptions = backend === 'gemini-live'
    const showQwenNote = backend === 'qwen-realtime'
    const showBackendHint = props.voiceBackend == null

    return (
        <div>
            {/* Tone & pace */}
            <button type="button" onClick={() => setTuningOpen((v) => !v)}
                className={`group flex min-h-12 w-full items-center justify-between gap-4 text-left ${settingsRowClass}`}
                aria-expanded={tuningOpen}>
                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.tuning.title')}</span>
                <span className="pw-plus text-[var(--app-fg)]" data-open={tuningOpen || undefined} aria-hidden="true" />
            </button>
            {tuningOpen && (
                <div className="pb-3">
                    {showBackendHint && (
                        <p className="py-2 text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.tuning.selectBackend')}</p>
                    )}
                    {showQwenNote && (
                        <p className="py-2 text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.tuning.qwenHint')}</p>
                    )}
                    {showElevenLabsSliders && (
                        <div>
                            <p className="pw-eyebrow pb-1 pt-1 text-[var(--app-hint)]">
                                {props.t('settings.voice.tuning.elevenlabs')}
                            </p>
                            <VoiceSlider label={props.t('settings.voice.tuning.stability')} hint={props.t('settings.voice.tuning.stabilityHint')}
                                value={prefs.elevenLabs.stability} min={0} max={1} step={0.05}
                                onChange={(stability) => setElevenLabs({ stability })} />
                            <VoiceSlider label={props.t('settings.voice.tuning.expressiveness')} hint={props.t('settings.voice.tuning.expressivenessHint')}
                                value={prefs.elevenLabs.style} min={0} max={1} step={0.05}
                                onChange={(style) => setElevenLabs({ style })} />
                            <VoiceSlider label={props.t('settings.voice.tuning.speakingRate')} hint={props.t('settings.voice.tuning.speakingRateHint')}
                                value={prefs.elevenLabs.speed} min={0.7} max={1.2} step={0.01}
                                onChange={(speed) => setElevenLabs({ speed })}
                                formatValue={(v) => `${v.toFixed(2)}×`} />
                            <VoiceSlider label={props.t('settings.voice.tuning.similarity')} hint={props.t('settings.voice.tuning.similarityHint')}
                                value={prefs.elevenLabs.similarity_boost} min={0} max={1} step={0.05}
                                onChange={(similarity_boost) => setElevenLabs({ similarity_boost })} />
                            <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
                                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.tuning.speakerBoost')}</span>
                                <SwitchControl label={props.t('settings.voice.tuning.speakerBoost')} checked={prefs.elevenLabs.use_speaker_boost}
                                    onChange={(use_speaker_boost) => setElevenLabs({ use_speaker_boost })} />
                            </label>
                        </div>
                    )}
                    {showGeminiOptions && (
                        <div>
                            <p className="pw-eyebrow pb-1 pt-1 text-[var(--app-hint)]">
                                {props.t('settings.voice.tuning.gemini')}
                            </p>
                            <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
                                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.tuning.affectiveDialog')}</span>
                                <SwitchControl label={props.t('settings.voice.tuning.affectiveDialog')} checked={prefs.gemini.affective_dialog}
                                    onChange={(checked) => setGeminiAffectiveDialog(checked)} />
                            </label>
                            <p className="pb-2 text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.tuning.affectiveDialogHint')}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

/** Debug/diagnostics panel for the Advanced section. */
export function VoiceDiagnosticsControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    const { prefs } = useVoicePersonality()
    const [fixturesOpen, setFixturesOpen] = useState(false)

    const backend = props.voiceBackend ?? 'elevenlabs'
    const wireHint = getVoiceWireBudgetHint(backend)
    const fixturesPreview = useMemo(() => getVoicePlatformFixturesPreview(), [])
    const composed = useMemo(
        () => resolveComposedVoiceSystemPrompt(prefs, { backend }),
        [prefs, backend]
    )
    const contextNotice = readVoiceContextNotice()

    return (
        <div>
            <div className={`space-y-1.5 ${settingsRowClass}`}>
            <p className="text-[13px] leading-snug text-[var(--app-hint)]">
                {props.t(wireHint.wireNoteKey)}
                {' '}{props.t('settings.voice.wireBudget.storage')}{wireHint.storageMaxChars.toLocaleString()}.
                {backend === 'elevenlabs' && (
                    <> {props.t('settings.voice.wireBudget.elevenlabsLimits')
                        .replace('{msg}', String(ELEVENLABS_WEBRTC_MAX_MESSAGE_BYTES))
                        .replace('{prompt}', String(ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES))}</>
                )}
            </p>
            {composed.truncated && (
                <p className="text-[13px] leading-snug text-[var(--app-badge-warning-text)]">
                    {props.t('settings.voice.wireBudget.promptTruncated')}
                </p>
            )}
            {contextNotice && (
                <p className="text-[13px] leading-snug text-[var(--app-fg)]">
                    {props.t('settings.voice.contextNotice')}: {contextNotice}
                </p>
            )}
            <p className="text-[13px] tabular-nums text-[var(--app-hint)]">
                {props.t('settings.voice.wireBudget.composedSize')}: {composed.wireBytes.toLocaleString()} B
            </p>
            </div>

            <button type="button" onClick={() => setFixturesOpen((v) => !v)}
                className={`group flex min-h-12 w-full items-center justify-between gap-4 text-left ${settingsRowClass}`}
                aria-expanded={fixturesOpen}>
                <span className="text-[15px] text-[var(--app-fg)]">{props.t('settings.voice.fixtures.title')}</span>
                <span className="pw-plus text-[var(--app-fg)]" data-open={fixturesOpen || undefined} aria-hidden="true" />
            </button>
            {fixturesOpen && (
                <div className="space-y-3 pb-4">
                    <p className="text-[13px] leading-snug text-[var(--app-hint)]">{props.t('settings.voice.fixtures.hint')}</p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap bg-[var(--app-subtle-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--app-hint)]">
                        {fixturesPreview}
                    </pre>
                </div>
            )}
        </div>
    )
}

/** @deprecated Use VoiceRespondsControls + VoicePersonaControls + VoiceSoundsControls instead. */
export function VoiceAdvancedControls(props: {
    t: Translate
    voiceBackend?: VoiceBackendKind | null
}) {
    return (
        <>
            <VoicePersonaControls {...props} />
            <VoiceSoundsControls {...props} />
        </>
    )
}
