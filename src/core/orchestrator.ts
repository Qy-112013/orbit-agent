import { EventEmitter } from 'node:events';
import { createRouter } from './router.ts';
import { id } from './ids.ts';
import { EVENT, ROLE, STRATEGY, asNonEmptyString } from './types.ts';
import type { ProviderAdapter, StoragePort } from './contracts.ts';
import type { SkillRegistry } from './skills.ts';

function taskFromPrompt(content) {
  const match = String(content ?? '').match(/(?:^|\n)\s*(?:task|任务)\s*[:：]\s*(.+)$/imu);
  return match?.[1]?.trim() || null;
}

function compact(text, limit = 180) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Coordinates routing, context assembly, provider calls and durable events.
 * The workflow boundary stays in one inspectable module: route, recall,
 * invoke, persist and publish an auditable event trail.
 */
export class Orchestrator {
  constructor({ store, registry, memory, provider, tools, skills }: { store: StoragePort; registry: any; memory: any; provider: ProviderAdapter; tools: any; skills?: SkillRegistry }) {
    this.store = store;
    this.registry = registry;
    this.memory = memory;
    this.provider = provider;
    this.tools = tools;
    this.skills = skills;
    this.router = createRouter(registry);
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.activeRuns = new Map();
  }

  subscribe(threadId, listener) {
    const handler = (event) => listener(event);
    this.events.on(`thread:${threadId}`, handler);
    return () => this.events.off(`thread:${threadId}`, handler);
  }

  async emit(threadId, type, payload = {}) {
    const event = await this.store.appendEvent({ threadId, type, payload });
    this.events.emit(`thread:${threadId}`, event);
    this.events.emit('event', event);
    return event;
  }

  async runAgent({ threadId, agentId, content, context, route, priorResults = [] }) {
    const agent = this.registry.get(agentId);
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    const startedAt = Date.now();
    await this.emit(threadId, EVENT.AGENT_STARTED, {
      runId: id('run'),
      agentId,
      agentName: agent.name,
      strategy: route.strategy,
    });
    try {
      const enrichedContent = priorResults.length
        ? `${content}\n\n前序 Agent 已给出以下结果，请在此基础上补充或指出分歧：\n${priorResults
            .map((result) => `- ${result.agentName}: ${compact(result.content, 500)}`)
            .join('\n')}`
        : content;
      const result = await this.provider.complete({ agent, content: enrichedContent, context });
      const latencyMs = Date.now() - startedAt;
      const message = await this.store.appendMessage({
        threadId,
        role: ROLE.ASSISTANT,
        agentId,
        content: result.content,
        citations: result.citations ?? [],
        metadata: {
          provider: result.provider,
          model: result.model,
          latencyMs,
          usage: result.usage ?? null,
          providerMetadata: result.metadata ?? null,
          strategy: route.strategy,
        },
      });
      await this.emit(threadId, EVENT.AGENT_COMPLETED, {
        messageId: message.id,
        agentId,
        agentName: agent.name,
        provider: result.provider,
        latencyMs,
      });
      return { ...message, agentName: agent.name };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = await this.store.appendMessage({
        threadId,
        role: ROLE.ASSISTANT,
        agentId,
        content: `执行失败：${String(error?.message ?? error).slice(0, 500)}\n\n线程状态已保留，可以重试或切换到其他 Agent。`,
        metadata: {
          status: 'error',
          latencyMs,
          strategy: route.strategy,
        },
      });
      await this.emit(threadId, EVENT.AGENT_FAILED, {
        messageId: message.id,
        agentId,
        agentName: agent.name,
        latencyMs,
        error: String(error?.message ?? error),
      });
      return { ...message, agentName: agent.name, failed: true };
    }
  }

  async submitMessage(threadId, content, options = {}) {
    const safeContent = asNonEmptyString(content, 'content');
    const thread = this.store.getThread(threadId);
    if (!thread) {
      const error = new Error(`thread not found: ${threadId}`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    // Serialize turns per thread so concurrent API submissions are preserved
    // in arrival order instead of silently sharing or dropping a result.
    const priorRun = this.activeRuns.get(threadId);
    const run = (priorRun
      ? priorRun.catch(() => undefined).then(() => this._submit(threadId, safeContent, options))
      : this._submit(threadId, safeContent, options)
    ).finally(() => {
      if (this.activeRuns.get(threadId) === run) this.activeRuns.delete(threadId);
    });
    this.activeRuns.set(threadId, run);
    return run;
  }

  async _submit(threadId, safeContent, options) {
    const userMessage = await this.store.appendMessage({
      threadId,
      role: ROLE.USER,
      content: safeContent,
      metadata: { clientRequestId: options.clientRequestId ?? null },
    });
    await this.emit(threadId, EVENT.MESSAGE_ACCEPTED, { messageId: userMessage.id, contentLength: safeContent.length });

    const thread = this.store.getThread(threadId);
    const route = this.router.route(safeContent, thread);
    await this.emit(threadId, EVENT.ROUTE_DECIDED, {
      targets: route.targets,
      strategy: route.strategy,
      mentions: route.mentions,
      unknown: route.unknown,
      reason: route.reason,
    });

    const rememberText = this.memory.parseRememberCommand(route.cleanContent);
    if (rememberText) {
      const memory = await this.tools.execute('remember', { text: rememberText }, { threadId, agentId: 'user' });
      await this.emit(threadId, EVENT.TOOL_CALLED, { tool: 'remember', memoryId: memory.id });
    }

    const context = this.memory.buildContext(threadId, route.cleanContent, { messageLimit: 14, memoryLimit: 6 });
    await this.emit(threadId, EVENT.CONTEXT_RETRIEVED, {
      memoryCount: context.memories.length,
      messageCount: context.recentMessages.length,
      citations: context.citations.map((citation) => citation.id),
    });

    const selectedSkills = this.skills?.select(route.cleanContent) ?? [];
    const providerContext = {
      ...context,
      skills: selectedSkills.map(({ id, name, content }) => ({ id, name, content })),
    };
    if (selectedSkills.length > 0) {
      await this.emit(threadId, EVENT.SKILLS_SELECTED, {
        skills: selectedSkills.map((skill) => ({ id: skill.id, name: skill.name })),
      });
    }

    const startedAt = Date.now();
    const runInput = { threadId, content: route.cleanContent, context: providerContext, route };
    let messages;
    if (route.strategy === STRATEGY.PARALLEL && route.targets.length > 1) {
      messages = await Promise.all(
        route.targets.map((agentId) => this.runAgent({ ...runInput, agentId })),
      );
    } else {
      messages = [];
      for (const agentId of route.targets) {
        const message = await this.runAgent({ ...runInput, agentId, priorResults: messages });
        messages.push(message);
      }
    }

    const taskTitle = taskFromPrompt(route.cleanContent);
    let task = null;
    if (taskTitle) {
      task = await this.tools.execute('create_task', { title: taskTitle, owner: route.targets[0] }, { threadId });
      await this.emit(threadId, EVENT.TOOL_CALLED, { tool: 'create_task', taskId: task.id, owner: route.targets[0] });
    }

    let coordinationMessage = null;
    if (messages.length > 1) {
      coordinationMessage = await this.store.appendMessage({
        threadId,
        role: ROLE.SYSTEM,
        content: `并行协作完成：${messages.map((message) => this.registry.get(message.agentId)?.name ?? message.agentId).join('、')} 分别给出了独立结果。`,
        metadata: { kind: 'coordination-summary', strategy: route.strategy },
      });
    }
    await this.store.touchThread(threadId, { activeAgentId: route.targets.at(-1) });
    await this.emit(threadId, EVENT.EXECUTION_COMPLETED, {
      strategy: route.strategy,
      targets: route.targets,
      messageIds: messages.map((message) => message.id),
      failedCount: messages.filter((message) => message.failed).length,
      taskId: task?.id ?? null,
      latencyMs: Date.now() - startedAt,
    });
    return { userMessage, route, context, messages, coordinationMessage, task };
  }
}
