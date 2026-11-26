import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { ClaudeModelsResponse } from '@hapi/protocol/apiTypes';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { listClaudeModels } from '../claudeModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerClaudeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<Record<string, never>, ClaudeModelsResponse>(RPC_METHODS.ListClaudeModels, async () => {
        try {
            return { success: true, models: await listClaudeModels() };
        } catch (error) {
            logger.debug('Failed to list Claude models:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Claude models'));
        }
    });
}
