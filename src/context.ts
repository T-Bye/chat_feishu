/**
 * Feishu message context builder
 *
 * Converts inbound Feishu messages to the standard OpenClaw message context format.
 * Uses the PluginRuntime API (core.channel.*) for all core functionality.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";
import type { FeishuInboundMessage } from "./webhook.js";
import type { HistoryEntry } from "./history.js";

/**
 * Feishu message context - returned by buildFeishuMessageContext
 */
export interface FeishuMessageContext {
  ctxPayload: Record<string, unknown>;
  message: FeishuInboundMessage;
  account: ResolvedFeishuAccount;
  chatId: string;
  isGroup: boolean;
  route: {
    agentId?: string;
    sessionKey: string;
    accountId: string;
    mainSessionKey?: string;
  };
  sendTyping: () => Promise<void>;
}

export interface BuildFeishuMessageContextParams {
  message: FeishuInboundMessage;
  account: ResolvedFeishuAccount;
  cfg: OpenClawConfig;
  botOpenId?: string;
  botName?: string;
  sendTyping?: () => Promise<void>;
  /** Pending group history entries for context */
  pendingHistory?: HistoryEntry[];
}

/**
 * Check if bot was mentioned in the message
 */
function normalizeMentionName(name: string): string {
  return name.trim().toLowerCase();
}

function isBotMentioned(
  message: FeishuInboundMessage,
  botOpenId?: string,
  botName?: string,
): boolean {
  if (!message.mentions || message.mentions.length === 0) {
    return false;
  }

  if (botOpenId && message.mentions.some((m) => m.id === botOpenId)) {
    return true;
  }

  if (botName) {
    const normalized = normalizeMentionName(botName);
    if (
      message.mentions.some(
        (m) => m.name && normalizeMentionName(m.name) === normalized,
      )
    ) {
      return true;
    }
    const displayText = message.displayText ?? message.text ?? "";
    if (displayText.toLowerCase().includes(`@${normalized}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Strip bot mention from message text
 */
function stripBotMention(text: string, mentions?: FeishuInboundMessage["mentions"]): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }

  let result = text;
  for (const mention of mentions) {
    // Remove @_user_X placeholder and surrounding whitespace
    const placeholder = mention.key;
    result = result.replace(new RegExp(`\\s*${placeholder}\\s*`, "g"), " ").trim();
  }
  return result;
}

/**
 * Build sender label for envelope
 */
function buildSenderLabel(message: FeishuInboundMessage): string {
  return message.senderOpenId ?? message.senderId;
}

/**
 * Build conversation label
 */
function buildConversationLabel(message: FeishuInboundMessage, isGroup: boolean): string {
  if (isGroup) {
    return `group:${message.chatId}`;
  }
  return buildSenderLabel(message);
}

/**
 * Format a history entry for display in context
 */
function formatHistoryEntry(entry: HistoryEntry): string {
  return `[${entry.sender}]: ${entry.body}`;
}

/**
 * Build history context string from entries
 */
function buildHistoryContext(entries: HistoryEntry[], currentMessage: string): string {
  if (entries.length === 0) {
    return currentMessage;
  }

  const historyLines = entries.map(formatHistoryEntry);
  return `[Recent conversation context]\n${historyLines.join("\n")}\n[/Recent conversation context]\n\n${currentMessage}`;
}

/**
 * Build Feishu message context for dispatch
 *
 * Uses PluginRuntime API (core.channel.*) for all core functionality:
 * - core.channel.routing.resolveAgentRoute
 * - core.channel.session.resolveStorePath
 * - core.channel.session.readSessionUpdatedAt
 * - core.channel.reply.resolveEnvelopeFormatOptions
 * - core.channel.reply.formatAgentEnvelope
 * - core.channel.reply.finalizeInboundContext
 * - core.channel.session.recordInboundSession
 */
export async function buildFeishuMessageContext(
  params: BuildFeishuMessageContextParams,
): Promise<FeishuMessageContext | null> {
  const { message, account, cfg, botOpenId, botName, sendTyping, pendingHistory } = params;
  const core = getFeishuRuntime();

  const isGroup = message.chatType === "group";
  const peerId = message.chatId;

  // Resolve agent route using core API
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const sessionKey = route.sessionKey;

  // DM policy check
  if (!isGroup) {
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      if (core.logging.shouldLogVerbose()) {
        core.logging.getChildLogger({ module: "feishu" }).debug("blocked DM (dmPolicy=disabled)");
      }
      return null;
    }

    if (dmPolicy !== "open") {
      const allowFrom = account.config.allowFrom ?? [];
      const senderId = message.senderOpenId ?? message.senderId;
      const allowed = allowFrom.length === 0 || allowFrom.includes(senderId);
      if (!allowed && dmPolicy === "allowlist") {
        if (core.logging.shouldLogVerbose()) {
          core.logging.getChildLogger({ module: "feishu" }).debug(`blocked unauthorized DM sender ${senderId}`);
        }
        return null;
      }
      // pairing mode would need additional handling
    }
  }

  // Group mention gating
  if (isGroup) {
    const groupPolicy = account.config.groupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") {
      if (core.logging.shouldLogVerbose()) {
        core.logging.getChildLogger({ module: "feishu" }).debug("blocked group message (groupPolicy=disabled)");
      }
      return null;
    }

    const requireMention = account.requireMention;
    const wasMentioned = isBotMentioned(message, botOpenId, botName);
    const canIdentifyBot = Boolean(botOpenId || botName);

    // Simple mention gating: if requireMention is true and bot was not mentioned, skip
    if (requireMention && !wasMentioned) {
      if (!canIdentifyBot) {
        // Bot identity not resolved; allow to avoid blocking all group messages
        core.logging.getChildLogger({ module: "feishu" }).warn(
          "bot open_id/name unavailable; allowing group message without mention check",
        );
      } else {
        if (core.logging.shouldLogVerbose()) {
          core.logging
            .getChildLogger({ module: "feishu" })
            .debug("skipping group message (no mention)");
        }
        return null;
      }
    }
  }

  // Build message body
  const rawBody = message.displayText ?? message.text ?? "";
  const bodyForAgent = isGroup ? stripBotMention(rawBody, message.mentions) : rawBody;

  const senderLabel = buildSenderLabel(message);
  const conversationLabel = buildConversationLabel(message, isGroup);

  // Resolve store path and get previous timestamp using core API
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });

  // Format envelope with previous timestamp for elapsed time display
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const baseBody = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: conversationLabel,
    timestamp: message.createTime,
    previousTimestamp,
    body: bodyForAgent,
    envelope: envelopeOptions,
  });

  // Build reply context
  const replySuffix = message.replyToBody
    ? `\n\n[Replying to ${message.replyToSenderId ?? "unknown"}]\n${message.replyToBody}\n[/Replying]`
    : "";

  const messageWithReply = baseBody + replySuffix;

  // Build group history context if available
  let combinedBody: string;
  if (isGroup && pendingHistory && pendingHistory.length > 0) {
    combinedBody = buildHistoryContext(pendingHistory, messageWithReply);
  } else {
    combinedBody = messageWithReply;
  }

  // Build context payload using core API
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    RawBody: rawBody,
    CommandBody: bodyForAgent,
    From: isGroup ? `feishu:group:${message.chatId}` : `feishu:${message.chatId}`,
    To: `feishu:${message.chatId}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    SenderName: senderLabel,
    SenderId: message.senderOpenId ?? message.senderId,
    Provider: "feishu" as const,
    Surface: "feishu" as const,
    MessageSid: message.messageId,
    ReplyToId: message.replyToId,
    ReplyToBody: message.replyToBody,
    ReplyToSender: message.replyToSenderId,
    Timestamp: message.createTime,
    WasMentioned: isGroup ? isBotMentioned(message, botOpenId) : undefined,
    MediaPath: message.mediaPath,
    MediaType: message.mediaType,
    MediaUrl: message.mediaPath,
    OriginatingChannel: "feishu" as const,
    OriginatingTo: `feishu:${message.chatId}`,
  });

  // Record session using core API
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: (ctxPayload as { SessionKey?: string }).SessionKey ?? sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: route.mainSessionKey ?? sessionKey,
          channel: "feishu",
          to: message.chatId,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      if (core.logging.shouldLogVerbose()) {
        core.logging.getChildLogger({ module: "feishu" }).debug(`failed updating session meta: ${String(err)}`);
      }
    },
  });

  if (core.logging.shouldLogVerbose()) {
    const preview = combinedBody.slice(0, 200).replace(/\n/g, "\\n");
    core.logging.getChildLogger({ module: "feishu" }).debug(
      `inbound: chatId=${message.chatId} from=${(ctxPayload as { From?: string }).From} len=${combinedBody.length} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    message,
    account,
    chatId: message.chatId,
    isGroup,
    route,
    sendTyping: sendTyping ?? (async () => {}),
  };
}
