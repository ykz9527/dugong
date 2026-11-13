import { useEffect, type RefObject } from 'react'

/**
 * Fade a page container in whenever `key` changes (usually the pathname).
 *
 * Runs through the Web Animations API instead of re-keying the subtree, so the
 * routed page keeps its state. Opacity only: a transform would briefly turn the
 * container into the containing block of any fixed-position descendant.
 */
export function usePageEnter(ref: RefObject<HTMLElement | null>, key: string): void {
    useEffect(() => {
        const element = ref.current
        if (!element || typeof element.animate !== 'function') return
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
        const animation = element.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        )
        return () => animation.cancel()
    }, [ref, key])
}
