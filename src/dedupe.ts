/**
 * Feishu message deduplication module
 *
 * Provides LRU-based deduplication to prevent processing duplicate messages,
 * which can occur due to WebSocket reconnections or webhook retries.
 */

export interface DedupeCache {
  /** Check if a message has already been processed */
  isProcessed(messageId: string): boolean;
  /** Mark a message as processed */
  markProcessed(messageId: string): void;
  /** Get the current size of the cache */
  size(): number;
  /** Clear all entries */
  clear(): void;
}

export interface DedupeCacheOptions {
  /** Maximum number of message IDs to track (default: 1000) */
  maxSize?: number;
  /** Cleanup when reaching this threshold (default: 800) */
  cleanupThreshold?: number;
}

/**
 * Create a deduplication cache for Feishu messages
 *
 * Uses a Set with LRU-like cleanup to track processed message IDs.
 * When the cache reaches maxSize, it removes the oldest entries
 * down to cleanupThreshold.
 *
 * @example
 * ```typescript
 * const dedupe = createFeishuDedupeCache();
 *
 * if (dedupe.isProcessed(messageId)) {
 *   return; // Skip duplicate
 * }
 * dedupe.markProcessed(messageId);
 * // Process message...
 * ```
 */
export function createFeishuDedupeCache(options: DedupeCacheOptions = {}): DedupeCache {
  const { maxSize = 1000, cleanupThreshold = 800 } = options;

  const processedMessages = new Set<string>();

  return {
    isProcessed(messageId: string): boolean {
      return processedMessages.has(messageId);
    },

    markProcessed(messageId: string): void {
      // LRU-like cleanup: remove oldest entries when reaching max size
      if (processedMessages.size >= maxSize) {
        const toDelete = processedMessages.size - cleanupThreshold;
        const iterator = processedMessages.values();

        for (let i = 0; i < toDelete; i++) {
          const value = iterator.next().value;
          if (value) {
            processedMessages.delete(value);
          }
        }
      }

      processedMessages.add(messageId);
    },

    size(): number {
      return processedMessages.size;
    },

    clear(): void {
      processedMessages.clear();
    },
  };
}

/**
 * Default deduplication cache configuration
 */
export const DEFAULT_DEDUPE_MAX_SIZE = 1000;
export const DEFAULT_DEDUPE_CLEANUP_THRESHOLD = 800;
