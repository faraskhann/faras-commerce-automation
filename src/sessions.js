import { config } from "./config.js";

/**
 * In-memory conversation history, keyed by sessionId.
 * Fine for a first working version — history is lost on restart and is not
 * shared across processes. Swap for Redis/Postgres when that matters.
 */
const sessions = new Map();

export function getHistory(sessionId) {
  return sessions.get(sessionId) ?? [];
}

export function setHistory(sessionId, messages) {
  // Keep only the most recent turns so a long-lived session can't grow forever.
  const trimmed = trimHistory(messages, config.maxHistoryMessages);
  sessions.set(sessionId, trimmed);
}

export function clearSession(sessionId) {
  return sessions.delete(sessionId);
}

export function sessionCount() {
  return sessions.size;
}

/**
 * Drop the oldest messages, but never start the history on an assistant turn
 * or on a user turn that only carries tool_result blocks — the API requires
 * the first message to be a user message and rejects orphaned tool results.
 */
function trimHistory(messages, max) {
  if (messages.length <= max) return messages;

  let start = messages.length - max;
  while (start < messages.length && !isPlainUserMessage(messages[start])) {
    start += 1;
  }
  return messages.slice(start);
}

function isPlainUserMessage(message) {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return !message.content.some((block) => block.type === "tool_result");
}
