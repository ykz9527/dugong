import { ASSISTANT_SYSTEM_PROMPT } from '@/claude/assistantRole'
import { trimIdent } from '@/utils/trimIdent'

/** The assistant prompt is written for Claude; this maps it onto agy. */
const AGY_ASSISTANT_NOTE = trimIdent(`
    # Running on agy
    - Tools written below as mcp__hapi__<name> are your mcp_hapi_<name> tools.
    - You have no AskUserQuestion tool. Where the rules below say to stop and ask with it, ask in your reply and end the turn.
    - ping_peer, task_start, task_cancel, task_move and peer_respond ask the person first. When one returns saying the person has not answered yet, do not call it again: the outcome arrives later in a message starting with [dugong].
`)

/** Appended to agy's own system prompt via ACP `_meta.antigravity.systemPrompt.append`. */
export const AGY_ASSISTANT_SYSTEM_PROMPT = `${AGY_ASSISTANT_NOTE}\n\n${ASSISTANT_SYSTEM_PROMPT}`
