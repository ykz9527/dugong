import { trimIdent } from '@/utils/trimIdent';

/**
 * When to call the `await_background_task` MCP tool. A task leaves
 * `running` when the turn ends unless background *agents* are still going; a
 * backgrounded shell does not hold it, because the usual one is a server left
 * up for the operator. This is how the agent marks the other kind.
 */
export const AWAIT_BACKGROUND_TASK_TOOL_DESCRIPTION = trimIdent(`
    Declare that you are waiting on a background command's result, so the dugong task list keeps this task in "running" after your reply ends instead of moving it to review. Pass the background task id (or a pid).
    The declaration is released when that task exits or when you start your next reply; declare again if you are still waiting then.
    Do not call it for servers or watchers left running for the user (preview/dev servers, file watchers): those should let the task go to review.
`);

export const AWAIT_BACKGROUND_TASK_PROMPT_CLAUDE = trimIdent(`
    If you are about to end your reply while still waiting on a background command whose result you need before continuing (a long build, test or pipeline run you will follow up on, e.g. by restarting a preview and taking screenshots), call "mcp__hapi__await_background_task" with its background task id right before you stop. That keeps the task in "running" on the task list instead of sending it to review. The wait is released when the command exits or when you start your next reply; call it again if you go back to waiting.
    Do not call it for processes you leave running for the user, such as preview or dev servers and watchers: those never finish, and the task should go to review.
`);
