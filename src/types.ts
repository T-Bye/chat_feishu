/**
 * Feishu channel types
 *
 * This module consolidates all public types for the Feishu channel plugin.
 * Types are organized into the following categories:
 * - Configuration Types: Plugin and account configuration
 * - API Types: Request/response structures for Feishu API
 * - Message Types: Message content formats (text, post, card)
 * - Event Types: Webhook and WebSocket event structures
 * - Utility Types: Helper types for common operations
 */

// ============ Configuration Types ============

/** API Domain: "feishu" for China, "lark" for International */
export type FeishuDomain = "feishu" | "lark";

/** Connection mode for receiving events */
export type FeishuConnectionMode = "websocket" | "webhook";

/** Render mode for outgoing messages */
export type FeishuRenderMode = "auto" | "raw" | "card";

/** DM policy */
export type FeishuDmPolicy = "open" | "pairing" | "allowlist";

/** Group policy */
export type FeishuGroupPolicy = "open" | "allowlist" | "disabled";

export interface FeishuAccountConfig {
  /** Application ID from Feishu Open Platform */
  appId?: string;
  /** Application Secret from Feishu Open Platform */
  appSecret?: string;
  /** API Domain: "feishu" (China) or "lark" (International). Default: "feishu" */
  domain?: FeishuDomain;
  /** Connection mode: "websocket" (recommended) or "webhook". Default: "websocket" */
  connectionMode?: FeishuConnectionMode;
  /** Webhook path for receiving events (only used when connectionMode is "webhook") */
  webhookPath?: string;
  /** Verification token for event validation */
  verificationToken?: string;
  /** Encrypt key for event decryption (optional) */
  encryptKey?: string;
  /** DM policy: "pairing" | "open" | "allowlist". Default: "pairing" */
  dmPolicy?: FeishuDmPolicy;
  /** Allowed senders for DM (when dmPolicy is "allowlist") */
  allowFrom?: string[];
  /** Group policy: "open" | "allowlist" | "disabled". Default: "allowlist" */
  groupPolicy?: FeishuGroupPolicy;
  /** Whether to require @mention in group chats. Default: true */
  requireMention?: boolean;
  /** Max media size in MB. Default: 30 */
  mediaMaxMb?: number;
  /** Render mode: "auto" | "raw" | "card". Default: "auto" */
  renderMode?: FeishuRenderMode;
  /** Allowed groups (when groupPolicy is "allowlist") */
  groups?: Record<string, { enabled?: boolean; name?: string }>;
}

export interface FeishuChannelConfig {
  enabled?: boolean;
  /** Default account configuration */
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  connectionMode?: FeishuConnectionMode;
  webhookPath?: string;
  verificationToken?: string;
  encryptKey?: string;
  dmPolicy?: FeishuDmPolicy;
  allowFrom?: string[];
  groupPolicy?: FeishuGroupPolicy;
  requireMention?: boolean;
  mediaMaxMb?: number;
  renderMode?: FeishuRenderMode;
  groups?: Record<string, { enabled?: boolean; name?: string }>;
  /** Named accounts */
  accounts?: Record<string, FeishuAccountConfig & { enabled?: boolean; name?: string }>;
}

export interface ResolvedFeishuAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appId?: string;
  appSecret?: string;
  appIdSource: "config" | "env" | "none";
  appSecretSource: "config" | "env" | "none";
  /** API base URL based on domain */
  apiBase: string;
  /** WebSocket URL for long connection */
  wsUrl: string;
  domain: FeishuDomain;
  connectionMode: FeishuConnectionMode;
  webhookPath?: string;
  verificationToken?: string;
  encryptKey?: string;
  renderMode: FeishuRenderMode;
  requireMention: boolean;
  config: FeishuAccountConfig;
}

// ============ API Types ============

export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

export interface FeishuApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export type FeishuReceiveIdType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";

export type FeishuMsgType = "text" | "post" | "image" | "file" | "audio" | "media" | "sticker" | "interactive" | "share_chat" | "share_user";

// ============ Message Types ============

export interface FeishuTextContent {
  text: string;
}

export interface FeishuPostContent {
  zh_cn?: FeishuPostBody;
  en_us?: FeishuPostBody;
}

export interface FeishuPostBody {
  title?: string;
  content: FeishuPostElement[][];
}

export type FeishuPostElement =
  | { tag: "text"; text: string; un_escape?: boolean }
  | { tag: "a"; text: string; href: string }
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "img"; image_key: string; width?: number; height?: number }
  | { tag: "media"; file_key: string; image_key?: string }
  | { tag: "emotion"; emoji_type: string };

export interface FeishuInteractiveContent {
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
  };
  header?: {
    title?: {
      tag: "plain_text" | "lark_md";
      content: string;
    };
    template?: string;
  };
  elements?: FeishuCardElement[];
}

export type FeishuCardElement =
  | { tag: "div"; text?: { tag: string; content: string }; fields?: Array<{ is_short: boolean; text: { tag: string; content: string } }> }
  | { tag: "hr" }
  | { tag: "action"; actions: Array<{ tag: string; text?: { tag: string; content: string }; url?: string; type?: string; value?: unknown }> }
  | { tag: "note"; elements: Array<{ tag: string; content?: string; img_key?: string }> }
  | { tag: "markdown"; content: string };

export interface FeishuSendMessageRequest {
  receive_id: string;
  msg_type: FeishuMsgType;
  content: string;
  uuid?: string;
}

export interface FeishuSendMessageResponse {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  msg_type: string;
  create_time: string;
  update_time: string;
  deleted: boolean;
  updated: boolean;
  chat_id: string;
  sender: {
    id: string;
    id_type: string;
    sender_type: string;
    tenant_key: string;
  };
  body: {
    content: string;
  };
}

// ============ Event Types ============

export interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  create_time: string;
  token: string;
  app_id: string;
  tenant_key: string;
}

export interface FeishuEventBase {
  schema: string;
  header: FeishuEventHeader;
  event: unknown;
}

export interface FeishuUrlVerificationEvent {
  challenge: string;
  token: string;
  type: "url_verification";
}

export interface FeishuMessageReceiveEvent extends FeishuEventBase {
  header: FeishuEventHeader & { event_type: "im.message.receive_v1" };
  event: {
    sender: {
      sender_id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      sender_type: string;
      tenant_key: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      update_time?: string;
      chat_id: string;
      chat_type: "p2p" | "group";
      message_type: FeishuMsgType;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          union_id?: string;
          user_id?: string;
          open_id?: string;
        };
        name: string;
        tenant_key?: string;
      }>;
    };
  };
}

export interface FeishuBotAddedEvent extends FeishuEventBase {
  header: FeishuEventHeader & { event_type: "im.chat.member.bot.added_v1" };
  event: {
    chat_id: string;
    operator_id: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    external: boolean;
    operator_tenant_key: string;
  };
}

export interface FeishuBotRemovedEvent extends FeishuEventBase {
  header: FeishuEventHeader & { event_type: "im.chat.member.bot.deleted_v1" };
  event: {
    chat_id: string;
    operator_id: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    external: boolean;
    operator_tenant_key: string;
  };
}

export type FeishuEvent =
  | FeishuUrlVerificationEvent
  | FeishuMessageReceiveEvent
  | FeishuBotAddedEvent
  | FeishuBotRemovedEvent;

// ============ Utility Types ============

export interface FeishuTokenCache {
  token: string;
  expiresAt: number;
}

export interface FeishuSendOptions {
  accountId?: string;
  receiveIdType?: FeishuReceiveIdType;
  replyToId?: string;
}

export interface FeishuSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// ============ Re-exports from Other Modules ============
// For unified type access, we re-export commonly used types

/** Re-export inbound message type from webhook module */
export type { FeishuInboundMessage, FeishuWebhookResult } from "./webhook.js";

/** Re-export WebSocket types */
export type { WSConnectionState, FeishuWSClient, WSClientOptions } from "./websocket.js";

/** Re-export deduplication types */
export type { DedupeCache, DedupeCacheOptions } from "./dedupe.js";

/** Re-export history management types */
export type {
  HistoryEntry,
  GroupHistoryManager,
  GroupHistoryManagerOptions,
} from "./history.js";

/** Re-export card building types from api module */
export type { CardColor, CardBaseOptions, CardButton, CardSection } from "./api.js";
