import { useCallback, useEffect, useRef, useState } from 'react'

export type SidebarResizeOptions = {
    /** localStorage key the width persists under. */
    storageKey: string
    /** Which edge of the window the panel sits on. A right-hand panel grows as
     *  the handle moves left, and its handle sits before it, not after. */
    side: 'left' | 'right'
    minWidth: number
    maxWidth: number
    defaultWidth: number
}

const LEFT_SIDEBAR: SidebarResizeOptions = {
    storageKey: 'hapi-sidebar-width',
    side: 'left',
    // Room for the header on one line: mark, title, count and four actions.
    minWidth: 300,
    maxWidth: 600,
    defaultWidth: 420
}

function clamp(value: number, options: SidebarResizeOptions): number {
    return Math.min(options.maxWidth, Math.max(options.minWidth, value))
}

function loadWidth(options: SidebarResizeOptions): number {
    const stored = localStorage.getItem(options.storageKey)
    if (stored) {
        const parsed = Number(stored)
        if (Number.isFinite(parsed)) return clamp(parsed, options)
    }
    return options.defaultWidth
}

export function useSidebarResize(options: SidebarResizeOptions = LEFT_SIDEBAR) {
    const [width, setWidth] = useState(() => loadWidth(options))
    const [isDragging, setIsDragging] = useState(false)
    const startXRef = useRef(0)
    const startWidthRef = useRef(0)
    const activePointerIdRef = useRef<number | null>(null)

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        // The sidebar (the handle's neighbour on the panel's side) can render narrower than the
        // stored width when the viewport cap in index.css kicks in on a compact
        // split. Seed the drag from the actual rendered width so there's no dead
        // zone before the sidebar responds. Falls back to the stored width when the
        // element or its measured width is unavailable (e.g. non-DOM test env).
        const sidebarEl = (options.side === 'left'
            ? e.currentTarget.previousElementSibling
            : e.currentTarget.nextElementSibling) as HTMLElement | null
        const renderedWidth = sidebarEl?.getBoundingClientRect().width
        activePointerIdRef.current = e.pointerId
        startXRef.current = e.clientX
        startWidthRef.current = renderedWidth || width
        setIsDragging(true)
    }, [width, options.side])

    // Global listeners ensure pointerup is always captured even if cursor leaves the handle
    useEffect(() => {
        if (!isDragging) return

        const onMove = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            const moved = e.clientX - startXRef.current
            const delta = options.side === 'left' ? moved : -moved
            setWidth(Math.min(options.maxWidth, Math.max(options.minWidth, startWidthRef.current + delta)))
        }

        const onUp = (e: PointerEvent) => {
            if (e.pointerId !== activePointerIdRef.current) return
            activePointerIdRef.current = null
            setIsDragging(false)
        }

        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)

        return () => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
        }
    }, [isDragging, options.side, options.minWidth, options.maxWidth])

    // Persist width to localStorage when drag ends
    useEffect(() => {
        if (!isDragging) {
            localStorage.setItem(options.storageKey, String(width))
        }
    }, [isDragging, width, options.storageKey])

    // Prevent text selection while dragging
    useEffect(() => {
        if (isDragging) {
            document.body.style.userSelect = 'none'
            document.body.style.cursor = 'col-resize'
        } else {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        return () => {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
    }, [isDragging])

    return { width, isDragging, onPointerDown }
}
