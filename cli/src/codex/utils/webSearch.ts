function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Result text for a web search card. Codex does not hand back the results it
 * read, only what it did, so say that instead of leaving the card empty.
 *
 * The app-server spells action types in camelCase, transcripts in snake_case.
 */
export function describeCodexWebSearch(query: string | null, action: Record<string, unknown> | null): string {
    const type = text(action?.type);
    if (type === 'openPage' || type === 'open_page') {
        const url = text(action?.url);
        if (url) return `Opened ${url}`;
    }
    if (type === 'findInPage' || type === 'find_in_page') {
        const url = text(action?.url);
        const pattern = text(action?.pattern);
        if (url && pattern) return `Searched for "${pattern}" in ${url}`;
        if (url) return `Searched in ${url}`;
    }
    const queries = Array.isArray(action?.queries)
        ? action.queries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
    const searched = queries.length > 0 ? queries : [text(action?.query) ?? query].filter((entry): entry is string => Boolean(entry));
    if (searched.length === 0) return 'Searched the web';
    return `Searched the web for ${searched.map((entry) => `"${entry}"`).join(', ')}`;
}
