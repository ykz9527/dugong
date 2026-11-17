import type { ChatBlock, UserTextBlock } from '@/chat/types'
import type { UserTurn } from '@/types/api'

type Position = { at: number; seq: number }

export type ConversationOutlineItem = {
    id: string
    targetMessageId: string
    kind: 'user'
    label: string
    createdAt: number
    /** Set for a turn that is not loaded: open the window on it first. */
    jumpTo?: { target: Position; end: Position | null }
}

const MAX_OUTLINE_LABEL_LENGTH = 96

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function truncateOutlineLabel(value: string, maxLength = MAX_OUTLINE_LABEL_LENGTH): string {
    const normalized = collapseWhitespace(value)
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function userBlockToOutlineItem(block: UserTextBlock): ConversationOutlineItem {
    const label = truncateOutlineLabel(block.text) || 'Empty message'
    return {
        id: `outline:user-text:${block.id}`,
        targetMessageId: `user-text:${block.id}`,
        kind: 'user',
        label,
        createdAt: block.createdAt
    }
}

function isLocatableOutlineBlock(block: ChatBlock): block is UserTextBlock {
    return block.kind === 'user-text'
        && !(block.invokedAt === null && block.status !== 'failed')
}

export function buildConversationOutline(blocks: readonly ChatBlock[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []

    for (const block of blocks) {
        if (isLocatableOutlineBlock(block)) {
            items.push(userBlockToOutlineItem(block))
        }
    }

    return items
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}

/**
 * The outline over the whole session: every turn the hub lists, using the
 * loaded row where the window has it, and a jump for the rest. Loaded user
 * messages the list does not have yet (sent after it was fetched) are kept.
 */
export function mergeOutlineWithTurns(
    loaded: readonly ConversationOutlineItem[],
    turns: readonly UserTurn[] | undefined
): ConversationOutlineItem[] {
    if (!turns || turns.length === 0) {
        return [...loaded]
    }
    const loadedByTarget = new Map(loaded.map((item) => [item.targetMessageId, item]))
    const merged: ConversationOutlineItem[] = []
    turns.forEach((turn, index) => {
        const targetMessageId = `user-text:${turn.id}`
        const inWindow = loadedByTarget.get(targetMessageId)
        if (inWindow) {
            merged.push(inWindow)
            loadedByTarget.delete(targetMessageId)
            return
        }
        const next = turns[index + 1]
        merged.push({
            id: `outline:turn:${turn.id}`,
            targetMessageId,
            kind: 'user',
            label: truncateOutlineLabel(turn.text) || 'Empty message',
            createdAt: turn.at,
            jumpTo: {
                target: { at: turn.at, seq: turn.seq },
                end: next ? { at: next.at, seq: next.seq } : null
            }
        })
    })
    merged.push(...loadedByTarget.values())
    return merged
}
