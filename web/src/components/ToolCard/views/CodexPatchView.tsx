import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { isObject } from '@hapi/protocol'
import { DiffView } from '@/components/DiffView'
import { parseUnifiedDiff } from '@/components/ToolCard/views/CodexDiffView'
import { basename, resolveDisplayPath } from '@/utils/path'

const MAX_COMPACT_FILES = 3

type PatchFile = {
    path: string
    oldText: string
    newText: string
} | {
    path: string
    oldText: null
    newText: null
}

function asText(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

/**
 * One file of a Codex patch as old/new text. Accepts the app-server shape
 * (`{ kind: { type }, diff }`, where `diff` is a unified diff for an update
 * and the file content for an add or delete) and the older event shape
 * (`{ add: { content } }` / `{ delete: { content } }` / `{ update: { unified_diff } }`).
 */
function toPatchFile(path: string, change: unknown): PatchFile {
    if (!isObject(change)) return { path, oldText: null, newText: null }

    const legacyAdd = isObject(change.add) ? asText(change.add.content) : null
    if (legacyAdd !== null) return { path, oldText: '', newText: legacyAdd }
    const legacyDelete = isObject(change.delete) ? asText(change.delete.content) : null
    if (legacyDelete !== null) return { path, oldText: legacyDelete, newText: '' }
    const legacyUpdate = isObject(change.update) ? asText(change.update.unified_diff) : null

    const diff = asText(change.diff) ?? asText(change.unified_diff) ?? legacyUpdate
    if (diff === null) return { path, oldText: null, newText: null }

    if (/^@@/m.test(diff)) {
        const parsed = parseUnifiedDiff(diff)
        return { path, oldText: parsed.oldText, newText: parsed.newText }
    }

    const kind = isObject(change.kind) ? asText(change.kind.type) : asText(change.kind)
    return kind === 'delete'
        ? { path, oldText: diff, newText: '' }
        : { path, oldText: '', newText: diff }
}

/**
 * Files in a raw `apply_patch` envelope, which is what a Codex transcript
 * records: `*** Add|Update|Delete File:` headers, each followed by
 * `+` / `-` / ` ` lines grouped under `@@` hunks.
 */
function parseApplyPatch(patch: string): PatchFile[] {
    const sections: Array<{ path: string; kind: string; old: string[]; next: string[] }> = []
    for (const line of patch.split('\n')) {
        const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
        if (header) {
            sections.push({ path: header[2].trim(), kind: header[1], old: [], next: [] })
            continue
        }
        const section = sections.at(-1)
        if (!section || line.startsWith('***') || line.startsWith('@@')) continue
        if (line.startsWith('+')) {
            section.next.push(line.slice(1))
        } else if (line.startsWith('-')) {
            section.old.push(line.slice(1))
        } else if (line.startsWith(' ')) {
            section.old.push(line.slice(1))
            section.next.push(line.slice(1))
        }
    }
    return sections.map((section) => section.kind === 'Delete'
        ? { path: section.path, oldText: null, newText: null }
        : { path: section.path, oldText: section.old.join('\n'), newText: section.next.join('\n') })
}

function getPatchFiles(input: unknown): PatchFile[] {
    if (typeof input === 'string') return parseApplyPatch(input)
    if (!isObject(input)) return []
    // The raw patch carries the lines; a `changes` map built from it may
    // hold only the file names.
    if (typeof input.patch === 'string') return parseApplyPatch(input.patch)
    if (!isObject(input.changes)) return []
    const changes = input.changes
    return Object.keys(changes).map((path) => toPatchFile(path, changes[path]))
}

export function CodexPatchView(props: ToolViewProps) {
    const files = getPatchFiles(props.block.tool.input)
    if (files.length === 0) return null

    const compact = props.surface !== 'dialog'
    const shown = compact ? files.slice(0, MAX_COMPACT_FILES) : files

    return (
        <div className="flex flex-col gap-2">
            {shown.map((file) => {
                const display = resolveDisplayPath(file.path, props.metadata)
                if (file.oldText === null) {
                    return (
                        <div key={file.path} className="text-sm text-[var(--app-fg)] font-mono break-all">
                            {basename(display)}
                        </div>
                    )
                }
                return (
                    <DiffView
                        key={file.path}
                        oldString={file.oldText}
                        newString={file.newText}
                        filePath={display}
                        variant="inline"
                        size={props.surface === 'dialog' ? 'comfortable' : undefined}
                        scrollY={props.surface === 'dialog'}
                    />
                )
            })}
            {files.length > shown.length ? (
                <div className="text-xs text-[var(--app-hint)]">
                    (+{files.length - shown.length} more files)
                </div>
            ) : null}
        </div>
    )
}
