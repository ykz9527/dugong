import { useSyncExternalStore } from 'react'
import type { Root, Element } from 'hast'
import type { VFile } from 'vfile'

/**
 * KaTeX on demand.
 *
 * KaTeX and its stylesheet are ~100 KB gzip, yet almost no message holds
 * math. This rehype plugin leaves math as plain code until a message that
 * has some is rendered; that render starts the import, and every markdown
 * view re-renders (through `useKatexRehypePlugins`) once it lands.
 */
type Transform = (tree: Root, file: VFile) => void

let transform: Transform | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

export function loadKatex(): Promise<void> {
    loading ??= import('./katexRuntime').then(({ createKatexTransform }) => {
        transform = createKatexTransform()
        for (const listener of listeners) listener()
    })
    return loading
}

const MATH_CLASSES = ['language-math', 'math-display', 'math-inline']

function hasMath(node: Root | Element): boolean {
    for (const child of node.children) {
        if (child.type !== 'element') continue
        const className = child.properties?.className
        if (Array.isArray(className) && className.some((name) => MATH_CLASSES.includes(String(name)))) {
            return true
        }
        if (hasMath(child)) return true
    }
    return false
}

export function rehypeKatexLazy() {
    return (tree: Root, file: VFile) => {
        if (transform) {
            transform(tree, file)
            return
        }
        if (hasMath(tree)) {
            void loadKatex()
        }
    }
}

const LAZY_PLUGINS = [rehypeKatexLazy]
// Same plugin, new array: a changed `rehypePlugins` prop is what makes the
// markdown views re-process once KaTeX is in.
const LOADED_PLUGINS = [rehypeKatexLazy]

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useKatexRehypePlugins(): typeof LAZY_PLUGINS {
    const loaded = useSyncExternalStore(subscribe, () => transform !== null, () => false)
    return loaded ? LOADED_PLUGINS : LAZY_PLUGINS
}

export const MARKDOWN_REHYPE_PLUGINS = LAZY_PLUGINS
