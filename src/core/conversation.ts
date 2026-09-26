import { nowIso, type ConversationSummary, type Message, type Thread } from './types.ts';

/**
 * Character budgets are explicit; they are not model-specific token counts.
 * History is append-only between compactions: it grows up to historyMessages /
 * historyChars, then older messages fold into the summary and keepMessages /
 * keepChars remain. The stable prefix lets providers reuse prompt caches.
 */
export const CONTEXT_LIMITS = Object.freeze({
  historyMessages: 24, historyChars: 24_000, keepMessages: 8, keepChars: 8_000, messageChars: 4_000,
  summaryChars: 5_000, memoryChars: 4_000, knowledgeChars: 7_000,
});

export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor((limit - 30) * 0.4);
  const marker = '\n…（中间内容已裁剪）…\n';
  return text.slice(0, head) + marker + text.slice(-(limit - head - marker.length));
}

/**
 * Splits unsummarized messages into the history sent to models and the older
 * messages that must fold into the summary. Each message is truncated to a fixed
 * length so the same message renders identically on every turn.
 */
export function planHistory(thread: Thread, { excludeMessageId }: { excludeMessageId?: string } = {}): { recentMessages: Message[]; pending: Message[] } {
  const throughSequence = thread.summary?.throughSequence ?? 0;
  const candidates = (thread.messages ?? [])
    .filter((message) => message.id !== excludeMessageId && message.sequence > throughSequence)
    .map((message) => ({ ...message, content: excerpt(message.content, CONTEXT_LIMITS.messageChars) }));
  const totalChars = candidates.reduce((sum, message) => sum + message.content.length, 0);
  if (candidates.length <= CONTEXT_LIMITS.historyMessages && totalChars <= CONTEXT_LIMITS.historyChars) {
    return { recentMessages: candidates, pending: [] };
  }
  let kept = 0;
  let keptChars = 0;
  for (const message of [...candidates].reverse()) {
    if (kept >= CONTEXT_LIMITS.keepMessages || (kept > 0 && keptChars + message.content.length > CONTEXT_LIMITS.keepChars)) break;
    kept += 1;
    keptChars += message.content.length;
  }
  return { recentMessages: candidates.slice(-kept), pending: candidates.slice(0, -kept) };
}

/** Deterministic fallback: keep early goals and the latest observations as attributed source excerpts. */
export function extractiveSummary(previous: ConversationSummary | undefined, pending: Message[], fallbackReason?: string): ConversationSummary {
  const additions = pending.map((message) => {
    const attribution = `${message.role}${message.agentId ? '/' + message.agentId : ''}`;
    return `[#${message.sequence} ${attribution}] ${excerpt(message.content.replace(/\s+/g, ' ').trim(), 500)}`;
  }).join('\n');
  return {
    text: excerpt([previous?.text, additions].filter(Boolean).join('\n'), CONTEXT_LIMITS.summaryChars),
    throughSequence: pending.at(-1)!.sequence,
    messageCount: (previous?.messageCount ?? 0) + pending.length,
    method: 'extractive-v1',
    ...(fallbackReason ? { fallbackReason } : {}),
    updatedAt: nowIso(),
  };
}

/** History plus an in-memory extractive summary; never calls a model or persists. */
export function conversationContext(thread: Thread, { excludeMessageId }: { excludeMessageId?: string } = {}): { recentMessages: Message[]; summary?: ConversationSummary } {
  const { recentMessages, pending } = planHistory(thread, { excludeMessageId });
  if (!pending.length) return { recentMessages, ...(thread.summary ? { summary: thread.summary } : {}) };
  return { recentMessages, summary: extractiveSummary(thread.summary, pending) };
}
