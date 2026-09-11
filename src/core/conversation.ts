import { nowIso, type ConversationSummary, type Message, type Thread } from './types.ts';

/** Character budgets are explicit; they are not model-specific token counts. */
export const CONTEXT_LIMITS = Object.freeze({
  recentMessages: 12, recentChars: 12_000, messageChars: 4_000,
  summaryChars: 5_000, memoryChars: 4_000, knowledgeChars: 7_000,
});

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor((limit - 30) * 0.4);
  const marker = '\n…（中间内容已裁剪）…\n';
  return text.slice(0, head) + marker + text.slice(-(limit - head - marker.length));
}

/** Keep early goals and the latest observations as attributed source excerpts. */
export function conversationContext(thread: Thread, { messageLimit = CONTEXT_LIMITS.recentMessages, excludeMessageId }: {
  messageLimit?: number; excludeMessageId?: string;
} = {}): { recentMessages: Message[]; summary?: ConversationSummary } {
  const messages = (thread.messages ?? []).filter((message) => message.id !== excludeMessageId);
  const recentMessages: Message[] = [];
  let remaining = CONTEXT_LIMITS.recentChars;
  const count = Math.max(1, Math.min(CONTEXT_LIMITS.recentMessages, Math.floor(messageLimit) || CONTEXT_LIMITS.recentMessages));
  for (const message of [...messages].reverse()) {
    if (recentMessages.length >= count || remaining < 200 || message.sequence <= (thread.summary?.throughSequence ?? 0)) break;
    const content = excerpt(message.content, Math.min(CONTEXT_LIMITS.messageChars, remaining));
    recentMessages.unshift({ ...message, content });
    remaining -= content.length;
  }
  const cutoff = recentMessages[0]?.sequence ?? (messages.at(-1)?.sequence ?? 0) + 1;
  const older = messages.filter((message) => message.sequence < cutoff && message.sequence > (thread.summary?.throughSequence ?? 0));
  if (!older.length) return { recentMessages, ...(thread.summary ? { summary: thread.summary } : {}) };
  const additions = older.map((message) => {
    const attribution = `${message.role}${message.agentId ? '/' + message.agentId : ''}`;
    return `[#${message.sequence} ${attribution}] ${excerpt(message.content.replace(/\s+/g, ' ').trim(), 500)}`;
  }).join('\n');
  const summary: ConversationSummary = {
    text: excerpt([thread.summary?.text, additions].filter(Boolean).join('\n'), CONTEXT_LIMITS.summaryChars),
    throughSequence: older.at(-1)!.sequence,
    messageCount: (thread.summary?.messageCount ?? 0) + older.length,
    method: 'extractive-v1',
    updatedAt: nowIso(),
  };
  return { recentMessages, summary };
}
