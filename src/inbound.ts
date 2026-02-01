/**
 * Feishu inbound message processing utilities
 *
 * This module provides helper functions for processing incoming messages.
 * The main message handling is done in channel.ts using context.ts and dispatch.ts.
 */

import type { ResolvedFeishuAccount, FeishuRenderMode } from "./types.js";
import type { FeishuInboundMessage } from "./webhook.js";
import type { HistoryEntry } from "./history.js";
import * as api from "./api.js";

/**
 * Logger interface for inbound processing
 */
export interface InboundLogger {
  info?(message: string): void;
  debug?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/**
 * Reply sender function signature
 */
export type ReplySender = (params: {
  text: string;
  replyToId?: string;
  renderMode?: FeishuRenderMode;
}) => Promise<{ ok: boolean; messageId?: string; error?: string }>;

/**
 * Media sender function signature
 */
export type MediaSender = (params: {
  text?: string;
  mediaUrl: string;
  replyToId?: string;
}) => Promise<{ ok: boolean; messageId?: string; error?: string }>;

/**
 * Fetch reply context if message is a reply
 *
 * When a message has a parentId (is a reply), this function fetches
 * the parent message content to provide context.
 */
export async function fetchReplyContext(
  account: ResolvedFeishuAccount,
  inbound: FeishuInboundMessage,
  log?: InboundLogger,
): Promise<FeishuInboundMessage> {
  if (!inbound.parentId) {
    return inbound;
  }

  try {
    const parentResult = await api.getMessage(account, inbound.parentId);
    if (parentResult.ok && parentResult.message) {
      return {
        ...inbound,
        replyToBody: parentResult.message.body,
        replyToSenderId: parentResult.message.senderId,
        replyToId: inbound.parentId,
      };
    }
  } catch (err) {
    log?.warn?.(`failed to fetch parent message ${inbound.parentId}: ${String(err)}`);
  }

  return inbound;
}

/**
 * Build history entry from inbound message
 */
export function buildHistoryEntry(inbound: FeishuInboundMessage): HistoryEntry {
  return {
    sender: inbound.senderOpenId ?? inbound.senderId,
    body: inbound.displayText ?? inbound.text ?? "",
    timestamp: inbound.createTime,
    messageId: inbound.messageId,
  };
}
