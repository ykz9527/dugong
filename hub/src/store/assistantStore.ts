import type { Database } from 'bun:sqlite'

import type { AssistantAgent, AssistantMemoryAuthor, AssistantQuestionStatus } from '@hapi/protocol'
import {
    acceptAssistantMemory,
    addAssistantGrant,
    closeAssistantQuestion,
    createAssistantQuestion,
    getAssistantQuestion,
    listAssistantQuestions,
    createAssistantMemory,
    deleteAssistantGrant,
    deleteAssistantMemory,
    getAssistantMemory,
    getAssistantMemoryByName,
    getAssistantAgent,
    getAssistantMachineId,
    getAssistantSessionId,
    hasAssistantGrant,
    listAssistantGrants,
    listAssistantMemories,
    setAssistantAgent,
    setAssistantMachineId,
    setAssistantSessionId,
    undoAssistantMemory,
    updateAssistantMemory,
    type AssistantMemoryPatch,
    type AssistantMemoryUndoResult,
    type CreateAssistantMemoryInput,
    type CreateAssistantQuestionInput
} from './assistant'
import type { StoredAssistantGrant, StoredAssistantMemory, StoredAssistantQuestion } from './types'

export class AssistantStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    listMemories(namespace: string, workspaceUserId: string): StoredAssistantMemory[] {
        return listAssistantMemories(this.db, namespace, workspaceUserId)
    }

    getMemory(id: string, namespace: string): StoredAssistantMemory | null {
        return getAssistantMemory(this.db, id, namespace)
    }

    getMemoryByName(
        namespace: string,
        workspaceUserId: string,
        scope: StoredAssistantMemory['scope'],
        scopeRef: string,
        name: string
    ): StoredAssistantMemory | null {
        return getAssistantMemoryByName(this.db, namespace, workspaceUserId, scope, scopeRef, name)
    }

    createMemory(input: CreateAssistantMemoryInput): StoredAssistantMemory {
        return createAssistantMemory(this.db, input)
    }

    updateMemory(
        id: string,
        namespace: string,
        patch: AssistantMemoryPatch,
        author: AssistantMemoryAuthor,
        source?: { sessionId: string; messageSeq: number | null } | null
    ): StoredAssistantMemory | null {
        return updateAssistantMemory(this.db, id, namespace, patch, author, source)
    }

    acceptMemory(id: string, namespace: string): StoredAssistantMemory | null {
        return acceptAssistantMemory(this.db, id, namespace)
    }

    deleteMemory(id: string, namespace: string): boolean {
        return deleteAssistantMemory(this.db, id, namespace)
    }

    undoMemory(id: string, namespace: string, ifUpdatedAt?: number): AssistantMemoryUndoResult {
        return undoAssistantMemory(this.db, id, namespace, ifUpdatedAt)
    }

    listQuestions(namespace: string, workspaceUserId: string): StoredAssistantQuestion[] {
        return listAssistantQuestions(this.db, namespace, workspaceUserId)
    }

    getQuestion(id: string, namespace: string): StoredAssistantQuestion | null {
        return getAssistantQuestion(this.db, id, namespace)
    }

    createQuestion(input: CreateAssistantQuestionInput): StoredAssistantQuestion {
        return createAssistantQuestion(this.db, input)
    }

    closeQuestion(
        id: string,
        namespace: string,
        status: Exclude<AssistantQuestionStatus, 'open'>,
        answer: string | null
    ): StoredAssistantQuestion | null {
        return closeAssistantQuestion(this.db, id, namespace, status, answer)
    }

    listGrants(workspaceUserId: string): StoredAssistantGrant[] {
        return listAssistantGrants(this.db, workspaceUserId)
    }

    addGrant(workspaceUserId: string, tool: string): StoredAssistantGrant {
        return addAssistantGrant(this.db, workspaceUserId, tool)
    }

    hasGrant(workspaceUserId: string, tool: string): boolean {
        return hasAssistantGrant(this.db, workspaceUserId, tool)
    }

    deleteGrant(id: string, workspaceUserId: string): boolean {
        return deleteAssistantGrant(this.db, id, workspaceUserId)
    }

    getSessionId(workspaceUserId: string, namespace: string): string | null {
        return getAssistantSessionId(this.db, workspaceUserId, namespace)
    }

    setSessionId(workspaceUserId: string, namespace: string, sessionId: string | null): boolean {
        return setAssistantSessionId(this.db, workspaceUserId, namespace, sessionId)
    }

    getAgent(workspaceUserId: string, namespace: string): AssistantAgent {
        return getAssistantAgent(this.db, workspaceUserId, namespace)
    }

    setAgent(workspaceUserId: string, namespace: string, agent: AssistantAgent): boolean {
        return setAssistantAgent(this.db, workspaceUserId, namespace, agent)
    }

    getMachineId(workspaceUserId: string, namespace: string): string | null {
        return getAssistantMachineId(this.db, workspaceUserId, namespace)
    }

    setMachineId(workspaceUserId: string, namespace: string, machineId: string | null): boolean {
        return setAssistantMachineId(this.db, workspaceUserId, namespace, machineId)
    }
}
