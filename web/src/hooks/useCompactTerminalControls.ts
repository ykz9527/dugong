import { useEffect, useState } from 'react'

// Phones and touch tablets: the terminal opens as its own page with an on-screen
// command box and key pads. Everything else gets the docked panel in the chat.
const COMPACT_TERMINAL_QUERY = '(max-width: 640px), (pointer: coarse)'

export function useCompactTerminalControls(): boolean {
    const [compact, setCompact] = useState(
        () => typeof window !== 'undefined' && window.matchMedia(COMPACT_TERMINAL_QUERY).matches
    )

    useEffect(() => {
        const media = window.matchMedia(COMPACT_TERMINAL_QUERY)
        const update = () => setCompact(media.matches)
        update()
        media.addEventListener('change', update)
        return () => media.removeEventListener('change', update)
    }, [])

    return compact
}
