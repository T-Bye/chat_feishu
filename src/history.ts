/**
 * Feishu group chat history management module
 *
 * Manages pending message history for group chats to provide context
 * when the bot is mentioned. Messages are accumulated until the bot
 * responds, then cleared.
 */

/**
 * History entry for a group chat message
 */
export interface HistoryEntry {
  /** Sender identifier (open_id or user_id) */
  sender: string;
  /** Message body text */
  body: string;
  /** Message timestamp (Unix milliseconds) */
  timestamp: number;
  /** Feishu message ID */
  messageId: string;
}

export interface GroupHistoryManager {
  /** Record a message to group history */
  record(chatId: string, entry: HistoryEntry): void;
  /** Get pending history entries for a group */
  get(chatId: string): HistoryEntry[];
  /** Clear history after bot replies */
  clear(chatId: string): void;
  /** Get number of groups being tracked */
  groupCount(): number;
  /** Clear all history */
  clearAll(): void;
}

export interface GroupHistoryManagerOptions {
  /** Maximum messages to keep per group (default: 10) */
  historyLimit?: number;
  /** Maximum groups to track (default: 100) */
  maxGroups?: number;
}

/**
 * Create a group history manager for Feishu
 *
 * Tracks pending messages in group chats that haven't triggered a bot response.
 * When the bot is mentioned, the history provides context for the conversation.
 * After the bot replies, the history is cleared.
 *
 * Uses LRU eviction for groups when maxGroups is exceeded.
 *
 * @example
 * ```typescript
 * const history = createGroupHistoryManager();
 *
 * // Record messages that don't trigger the bot
 * history.record(chatId, { sender, body, timestamp, messageId });
 *
 * // When bot is mentioned, get history for context
 * const pendingHistory = history.get(chatId);
 *
 * // After bot replies, clear the history
 * history.clear(chatId);
 * ```
 */
export function createGroupHistoryManager(
  options: GroupHistoryManagerOptions = {},
): GroupHistoryManager {
  const { historyLimit = 10, maxGroups = 100 } = options;

  const groupHistories = new Map<string, HistoryEntry[]>();

  return {
    record(chatId: string, entry: HistoryEntry): void {
      // LRU eviction: remove oldest groups when exceeding limit
      if (groupHistories.size > maxGroups) {
        const keysToDelete = groupHistories.size - maxGroups;
        const iterator = groupHistories.keys();

        for (let i = 0; i < keysToDelete; i++) {
          const key = iterator.next().value;
          if (key) {
            groupHistories.delete(key);
          }
        }
      }

      // Get or create history for this chat
      let history = groupHistories.get(chatId);
      if (!history) {
        history = [];
        groupHistories.set(chatId, history);
      }

      // Add entry and trim to limit (FIFO)
      history.push(entry);
      while (history.length > historyLimit) {
        history.shift();
      }

      // Refresh insertion order for LRU (move to end)
      if (groupHistories.has(chatId)) {
        groupHistories.delete(chatId);
        groupHistories.set(chatId, history);
      }
    },

    get(chatId: string): HistoryEntry[] {
      return groupHistories.get(chatId) ?? [];
    },

    clear(chatId: string): void {
      groupHistories.set(chatId, []);
    },

    groupCount(): number {
      return groupHistories.size;
    },

    clearAll(): void {
      groupHistories.clear();
    },
  };
}

/**
 * Default history management configuration
 */
export const DEFAULT_GROUP_HISTORY_LIMIT = 10;
export const DEFAULT_MAX_GROUPS = 100;
