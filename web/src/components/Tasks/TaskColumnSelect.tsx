import { TASK_COLUMNS, type TaskColumn } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

/**
 * Move a card to another column.
 *
 * One control for the detail panel and the sidebar list, so the places a card
 * can be moved from cannot drift apart in what they offer. Each host keeps its
 * own look through `className`.
 */
export function TaskColumnSelect(props: {
    column: TaskColumn
    disabled: boolean
    onChange: (column: TaskColumn) => void
    className: string
}) {
    const { t } = useTranslation()

    return (
        <select
            aria-label={t('board.card.moveTo')}
            value={props.column}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.value as TaskColumn)}
            className={props.className}
        >
            {TASK_COLUMNS.map((column) => (
                <option key={column} value={column}>{t(`board.column.${column}`)}</option>
            ))}
        </select>
    )
}
