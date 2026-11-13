import { describe, expect, it } from 'vitest';
import { buildCodexPermissionModeCliArgs, resolveCodexPermissionModeConfig } from './permissionModeConfig';

describe('resolveCodexPermissionModeConfig', () => {
    it('uses on-request approvals for default mode', () => {
        expect(resolveCodexPermissionModeConfig('default')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' },
            approvalsReviewer: 'user'
        });
    });

    it('keeps safe-yolo escalation available with a supported approval policy', () => {
        expect(resolveCodexPermissionModeConfig('safe-yolo')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' },
            approvalsReviewer: 'user'
        });
    });

    it('routes auto-mode escalations to Codex Auto Review', () => {
        expect(resolveCodexPermissionModeConfig('auto')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' },
            approvalsReviewer: 'auto_review'
        });
        expect(buildCodexPermissionModeCliArgs('auto')).toEqual([
            '--ask-for-approval', 'on-request',
            '--sandbox', 'workspace-write',
            '-c', 'approvals_reviewer="auto_review"'
        ]);
    });
});
