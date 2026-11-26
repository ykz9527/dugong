import { describe, expect, it, vi } from 'vitest'
import {
    classifyClaudeSlashCatalog,
    extractSDKMetadata,
    filterCatalogAffectingClaudeArgs
} from './metadataExtractor'

const queryMock = vi.hoisted(() => vi.fn())
vi.mock('./query', () => ({ query: queryMock }))

describe('Claude skill catalog', () => {
    const discoveredSkills = [
        { name: 'hapi', description: 'Manage HAPI' },
        { name: 'ponytail', description: 'Keep code simple' },
        { name: 'scanner-only', description: 'Not loaded by Claude' }
    ]

    it('separates native skills from slash commands and keeps plugin namespaces', () => {
        expect(classifyClaudeSlashCatalog(
            ['help', 'hapi', 'url-plugin:url-skill', 'ponytail:ponytail', 'review'],
            discoveredSkills,
            ['hapi', 'url-plugin:url-skill', 'ponytail:ponytail']
        )).toEqual({
            commands: ['help', 'review'],
            skills: [
                { name: 'hapi', description: 'Manage HAPI' },
                { name: 'url-plugin:url-skill', description: undefined },
                { name: 'ponytail:ponytail', description: 'Keep code simple' }
            ]
        })
    })

    it('keeps only launch arguments that affect the command catalog', () => {
        expect(filterCatalogAffectingClaudeArgs([
            '--resume', 'session-id',
            '--plugin-dir', '/tmp/my plugin',
            '--settings=/tmp/settings.json',
            '--add-dir', '/tmp/one', '/tmp/two',
            '--disable-slash-commands',
            '--model', 'sonnet'
        ])).toEqual([
            '--plugin-dir', '/tmp/my plugin',
            '--settings=/tmp/settings.json',
            '--add-dir', '/tmp/one', '/tmp/two',
            '--disable-slash-commands'
        ])
    })

})

describe('extractSDKMetadata', () => {
    it('probes without leaving a transcript behind', async () => {
        queryMock.mockImplementation(async function* () {
            yield { type: 'system', subtype: 'init', tools: ['Bash'], slash_commands: ['review'] }
        })

        const metadata = await extractSDKMetadata({ claudeArgs: ['--add-dir', '/x'] })

        expect(metadata.tools).toEqual(['Bash'])
        expect(queryMock.mock.calls[0][0].options.additionalArgs).toEqual(['--add-dir', '/x', '--no-session-persistence'])
    })
})
