import type { HighlighterCore, LanguageRegistration } from 'shiki/core'
import type { Root, RootContent } from 'hast'
import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

// Loaded with the highlighter, which is created on the first code block.
const THEMES = [
    () => import('@shikijs/themes/github-light'),
    () => import('@shikijs/themes/github-dark'),
]

// Common languages for LLM code output, each fetched the first time a block
// in that language is highlighted. Top-level `import()` calls here used to
// fetch and evaluate every grammar (~1.6 MB) as soon as this module loaded,
// on every page.
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
    // Shell
    shellscript: () => import('@shikijs/langs/shellscript'),
    powershell: () => import('@shikijs/langs/powershell'),
    // Data formats
    json: () => import('@shikijs/langs/json'),
    yaml: () => import('@shikijs/langs/yaml'),
    toml: () => import('@shikijs/langs/toml'),
    xml: () => import('@shikijs/langs/xml'),
    ini: () => import('@shikijs/langs/ini'),
    // Markup
    markdown: () => import('@shikijs/langs/markdown'),
    html: () => import('@shikijs/langs/html'),
    css: () => import('@shikijs/langs/css'),
    scss: () => import('@shikijs/langs/scss'),
    // JavaScript ecosystem
    javascript: () => import('@shikijs/langs/javascript'),
    typescript: () => import('@shikijs/langs/typescript'),
    jsx: () => import('@shikijs/langs/jsx'),
    tsx: () => import('@shikijs/langs/tsx'),
    // Query languages
    sql: () => import('@shikijs/langs/sql'),
    graphql: () => import('@shikijs/langs/graphql'),
    // Systems languages
    c: () => import('@shikijs/langs/c'),
    rust: () => import('@shikijs/langs/rust'),
    go: () => import('@shikijs/langs/go'),
    // JVM
    java: () => import('@shikijs/langs/java'),
    kotlin: () => import('@shikijs/langs/kotlin'),
    // Scripting
    python: () => import('@shikijs/langs/python'),
    php: () => import('@shikijs/langs/php'),
    // Apple
    swift: () => import('@shikijs/langs/swift'),
    // .NET
    csharp: () => import('@shikijs/langs/csharp'),
    // DevOps
    dockerfile: () => import('@shikijs/langs/dockerfile'),
    make: () => import('@shikijs/langs/make'),
    // Misc
    diff: () => import('@shikijs/langs/diff'),
}

export const SHIKI_THEMES = {
    light: 'github-light',
    dark: 'github-dark',
} as const

// Alias common code fence language names to canonical names
export const langAlias: Record<string, string> = {
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    shell: 'shellscript',
    ps1: 'powershell',
    js: 'javascript',
    ts: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    yml: 'yaml',
    md: 'markdown',
    htm: 'html',
    pgsql: 'sql',
    mysql: 'sql',
    postgres: 'sql',
    gql: 'graphql',
    py: 'python',
    rs: 'rust',
    kt: 'kotlin',
    cs: 'csharp',
    makefile: 'make',
}

// Singleton highlighter instance
let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
        // The core and its regex engine (~150 KB gzip) load with the first
        // code block, not with every page.
        highlighterPromise = Promise.all([
            import('shiki/core'),
            import('shiki/engine/javascript'),
        ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => createHighlighterCore({
            themes: THEMES,
            langs: [],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        }))
    }
    return highlighterPromise
}

const languageLoads = new Map<string, Promise<boolean>>()

/** Load `lang` into the highlighter if we bundle it; false when unsupported. */
function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
    if (lang === 'text') return Promise.resolve(false)
    // Also covers the aliases a loaded grammar declares (e.g. `golang`).
    if (highlighter.getLoadedLanguages().includes(lang)) return Promise.resolve(true)
    const loader = LANG_LOADERS[lang]
    if (!loader) return Promise.resolve(false)
    let load = languageLoads.get(lang)
    if (!load) {
        load = highlighter.loadLanguage(loader).then(() => true, () => false)
        languageLoads.set(lang, load)
    }
    return load
}

function resolveLanguage(lang: string | undefined): string {
    if (!lang) return 'text'
    const cleaned = lang.startsWith('language-') ? lang.slice('language-'.length) : lang
    const lower = cleaned.toLowerCase().trim()
    if (lower === 'text' || lower === 'plaintext' || lower === 'txt') return 'text'
    return langAlias[lower] ?? lower
}

/**
 * Normalize code the way the line renderer counts lines: a single trailing
 * newline is dropped so `"a\n"` is one line, not one line plus an empty
 * one. Shared by the highlighted and plain-text-fallback paths so both
 * produce the same number of lines.
 */
function stripTrailingNewline(code: string): string {
    return code.endsWith('\n') ? code.slice(0, -1) : code
}

/**
 * Split raw code into logical lines for the plain-text fallback (when
 * highlighting is unavailable). Mirrors the normalization applied before
 * highlighting so line numbers line up on both paths.
 */
export function splitCodeLines(code: string): string[] {
    return stripTrailingNewline(code).split('\n')
}

/**
 * Split an inline shiki hast tree into per-logical-line child arrays.
 *
 * With `structure: 'inline'`, shiki emits a flat list of token `<span>`s
 * with `<br>` elements marking line breaks (verified against the bundled
 * shiki version). Grouping on those `<br>` boundaries yields one child
 * array per source line, so each line can be rendered in its own grid row
 * with an aligned line number — even when the line wraps.
 *
 * The number of returned groups always equals `splitCodeLines(code).length`:
 * N lines have N-1 `<br>`s between them, so N-1 splits produce N groups
 * (including interior empty lines).
 */
export function splitHastLines(hast: Root): RootContent[][] {
    const lines: RootContent[][] = []
    let current: RootContent[] = []
    for (const child of hast.children) {
        if (child.type === 'element' && child.tagName === 'br') {
            lines.push(current)
            current = []
        } else {
            current.push(child)
        }
    }
    lines.push(current)
    return lines
}

function highlightToLineNodes(highlighter: HighlighterCore, code: string, lang: string): ReactNode[] {
    const hast = highlighter.codeToHast(stripTrailingNewline(code), {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: 'inline',
    })

    return splitHastLines(hast as Root).map((children) => {
        const lineRoot: Root = { type: 'root', children }
        return toJsxRuntime(lineRoot, { jsx, jsxs, Fragment }) as ReactNode
    })
}

/**
 * Custom hook for syntax highlighting with our minimal Shiki bundle.
 * Returns a single ReactNode of the highlighted code (inline structure),
 * or null while pending / for unsupported languages (plain-text fallback).
 */
export function useShikiHighlighter(
    code: string,
    language: string | undefined
): ReactNode | null {
    const [highlighted, setHighlighted] = useState<ReactNode | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            const supported = await ensureLanguage(highlighter, lang)
            if (cancelled) return

            // Skip highlighting for unsupported languages (graceful fallback to plain text)
            if (!supported) {
                setHighlighted(null)
                return
            }

            const hast = highlighter.codeToHast(code, {
                lang,
                themes: SHIKI_THEMES,
                defaultColor: false,
                structure: 'inline',
            })

            if (cancelled) return

            const rendered = toJsxRuntime(hast, {
                jsx,
                jsxs,
                Fragment,
            })
            setHighlighted(rendered as ReactNode)
        }

        // Debounce highlighting — 150ms reduces CPU pressure on Windows during
        // streaming where code blocks update rapidly (see #310)
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return highlighted
}

/**
 * Like {@link useShikiHighlighter} but returns the highlighted code split
 * into one ReactNode per logical line, so callers can render each line in
 * its own row with an aligned line number that survives wrapping. Returns
 * null while pending / for unsupported languages (the caller falls back to
 * splitting the raw `code` on newlines).
 */
export function useShikiHighlightedLines(
    code: string,
    language: string | undefined
): ReactNode[] | null {
    const [lines, setLines] = useState<ReactNode[] | null>(null)
    const lang = useMemo(() => resolveLanguage(language), [language])

    useEffect(() => {
        let cancelled = false

        async function highlight() {
            const highlighter = await getHighlighter()
            if (cancelled) return

            const supported = await ensureLanguage(highlighter, lang)
            if (cancelled) return

            // Skip highlighting for unsupported languages (graceful fallback to plain text)
            if (!supported) {
                setLines(null)
                return
            }

            const lineNodes = highlightToLineNodes(highlighter, code, lang)

            if (cancelled) return

            setLines(lineNodes)
        }

        // Debounce highlighting — 150ms reduces CPU pressure on Windows during
        // streaming where code blocks update rapidly (see #310)
        const timer = setTimeout(highlight, 150)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, lang])

    return lines
}
