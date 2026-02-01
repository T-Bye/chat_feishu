/**
 * Feishu message dispatch module
 *
 * Handles dispatching messages to the AI agent and delivering replies.
 * Uses the PluginRuntime API (core.channel.*) for all core functionality.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import type { FeishuMessageContext } from "./context.js";
import type { ResolvedFeishuAccount, FeishuRenderMode } from "./types.js";
import * as api from "./api.js";

/**
 * Reply payload structure
 */
export interface ReplyPayload {
  text: string;
  replyToId?: string;
  mediaUrl?: string;
}

/**
 * Dispatch options
 */
export interface DispatchFeishuMessageParams {
  /** Message context from buildFeishuMessageContext */
  context: FeishuMessageContext;
  /** OpenClaw configuration */
  cfg: OpenClawConfig;
  /** Callback for sending text replies */
  onSendReply?: (params: {
    text: string;
    replyToId?: string;
    renderMode?: FeishuRenderMode;
  }) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
  /** Callback for sending media */
  onSendMedia?: (params: {
    text?: string;
    mediaUrl: string;
    replyToId?: string;
  }) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
  /** Callback when reply starts */
  onReplyStart?: () => void;
  /** Callback when dispatch is idle */
  onIdle?: () => void;
}

/**
 * Dispatch result
 */
export interface DispatchResult {
  /** Whether a final reply was queued/sent */
  queuedFinal: boolean;
  /** Reply counts */
  counts: {
    final: number;
    interim: number;
  };
}

/**
 * Dispatch Feishu message to AI agent and deliver replies
 *
 * Uses PluginRuntime API (core.channel.*) for dispatch:
 * - core.channel.reply.createReplyDispatcherWithTyping
 * - core.channel.reply.resolveHumanDelayConfig
 * - core.channel.reply.dispatchReplyFromConfig
 * - core.channel.text.resolveTextChunkLimit
 * - core.channel.text.resolveMarkdownTableMode
 */
export async function dispatchFeishuMessage(
  params: DispatchFeishuMessageParams,
): Promise<DispatchResult> {
  const { context, cfg, onSendReply, onSendMedia, onReplyStart, onIdle } = params;
  const core = getFeishuRuntime();
  const logger = core.logging.getChildLogger({ module: "feishu" });

  const { ctxPayload, account, chatId, route } = context;

  // Get text configuration
  const _textLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu");
  const _tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: route.accountId,
  });

  // Create dispatcher with typing indicator support
  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        const text = payload.text ?? "";
        const mediaUrl = payload.mediaUrl;

        logger.info(`deliver called: text=${text.slice(0, 100)} mediaUrl=${mediaUrl}`);

        // Only use reply quote in group chats, not in DM/private chats
        const replyToId = context.isGroup ? context.message.messageId : undefined;
        logger.info(`dispatch deliver: isGroup=${context.isGroup} chatType=${context.message?.chatType} replyToId=${replyToId}`);

        if (mediaUrl && onSendMedia) {
          logger.info(`sending media to ${context.message.messageId} (isGroup=${context.isGroup})`);
          const result = await onSendMedia({
            text,
            mediaUrl,
            replyToId,
          });
          logger.info(`media send result: ${JSON.stringify(result)}`);
        } else if (text && onSendReply) {
          // Determine render mode based on content
          const renderMode = api.shouldUseCardRendering(text) ? "card" : account.renderMode;
          logger.info(`sending reply to ${context.message.messageId} renderMode=${renderMode} (isGroup=${context.isGroup})`);
          const result = await onSendReply({
            text,
            replyToId,
            renderMode,
          });
          logger.info(`reply send result: ${JSON.stringify(result)}`);
        } else {
          logger.warn(`deliver called but no handler: text=${!!text} onSendReply=${!!onSendReply}`);
        }
      },
      onError: (err, info) => {
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart,
      onIdle,
    });

  try {
    // Dispatch to agent
    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    if (queuedFinal && core.logging.shouldLogVerbose()) {
      logger.debug(`delivered ${counts.final} reply${counts.final === 1 ? "" : "ies"} to ${chatId}`);
    }

    return { queuedFinal, counts };
  } catch (err) {
    markDispatchIdle();
    logger.error(`dispatch failed: ${String(err)}`);
    return { queuedFinal: false, counts: { final: 0, interim: 0 } };
  }
}

/**
 * Create default reply sender using Feishu API
 * @param account - Feishu account
 * @param chatId - Chat ID for sending new messages (when not replying)
 */
export function createDefaultReplySender(
  account: ResolvedFeishuAccount,
  chatId: string,
  isGroup: boolean,
) {
  const core = getFeishuRuntime();
  const logger = core.logging.getChildLogger({ module: "feishu" });

  return async (params: {
    text: string;
    replyToId?: string;
    renderMode?: FeishuRenderMode;
  }) => {
    logger.info(
      `createDefaultReplySender: replyToId=${params.replyToId} chatId=${chatId} isGroup=${isGroup}`,
    );
    
    // If replyToId is provided, use reply API (quote reply)
    // Otherwise, send as new message without quote
    if (params.replyToId && isGroup) {
      logger.info(`Using replyMessage API (quote reply)`);
      return api.replyMessage(account, params.replyToId, params.text, {
        renderMode: params.renderMode,
      });
    }
    // Send as new message without quote (for DM/private chats)
    // Determine receiveIdType based on chatId format
    const receiveIdType = chatId.startsWith("ou_") ? "open_id" : "chat_id";
    logger.info(`Using sendSmart API (no quote) receiveIdType=${receiveIdType}`);
    return api.sendSmart(account, chatId, params.text, {
      renderMode: params.renderMode,
      receiveIdType,
    });
  };
}

/**
 * Create default media sender using Feishu API
 * @param account - Feishu account
 * @param chatId - Chat ID for sending new messages (when not replying)
 */
export function createDefaultMediaSender(
  account: ResolvedFeishuAccount,
  chatId: string,
  isGroup: boolean,
) {
  const core = getFeishuRuntime();
  const logger = core.logging.getChildLogger({ module: "feishu" });

  return async (params: {
    text?: string;
    mediaUrl: string;
    replyToId?: string;
  }) => {
    // For now, send media URL as text
    const text = params.text ? `${params.text}\n\n${params.mediaUrl}` : params.mediaUrl;
    
    logger.info(
      `createDefaultMediaSender: replyToId=${params.replyToId} chatId=${chatId} isGroup=${isGroup}`,
    );
    
    // If replyToId is provided, use reply API (quote reply)
    // Otherwise, send as new message without quote
    if (params.replyToId && isGroup) {
      logger.info(`Using replyMessage API (quote reply)`);
      return api.replyMessage(account, params.replyToId, text);
    }
    // Send as new message without quote (for DM/private chats)
    const receiveIdType = chatId.startsWith("ou_") ? "open_id" : "chat_id";
    logger.info(`Using sendSmart API (no quote) receiveIdType=${receiveIdType}`);
    return api.sendSmart(account, chatId, text, { receiveIdType });
  };
}
