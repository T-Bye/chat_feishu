/**
 * Feishu webhook event handling
 */

import type {
  FeishuUrlVerificationEvent,
  FeishuMessageReceiveEvent,
  FeishuBotAddedEvent,
  FeishuBotRemovedEvent,
  ResolvedFeishuAccount,
  FeishuMsgType,
} from "./types.js";

export interface FeishuInboundMessage {
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  senderId: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  messageType: FeishuMsgType;
  /** Raw content JSON string */
  content: string;
  /** Raw text with placeholders like @_user_1 */
  text?: string;
  /** Display text with placeholders replaced by actual names */
  displayText?: string;
  mentions?: Array<{
    key: string;
    id: string;
    name: string;
  }>;
  rootId?: string;
  parentId?: string;
  createTime: number;
  tenantKey: string;

  // Reply context fields (populated when message is a reply)
  /** The text content of the replied-to message */
  replyToBody?: string;
  /** The sender ID of the replied-to message */
  replyToSenderId?: string;
  /** The message ID of the replied-to message */
  replyToId?: string;

  // Media fields (for image/file/audio messages)
  /** Image key for image messages */
  imageKey?: string;
  /** File key for file messages */
  fileKey?: string;
  /** Original file name */
  fileName?: string;
  /** Local path after download */
  mediaPath?: string;
  /** Media MIME type */
  mediaType?: string;
}

export interface FeishuWebhookResult {
  type: "challenge" | "message" | "bot_added" | "bot_removed" | "unknown" | "error";
  challenge?: string;
  message?: FeishuInboundMessage;
  chatId?: string;
  error?: string;
}

/**
 * Parse and handle incoming Feishu webhook event
 */
export function parseWebhookEvent(
  body: unknown,
  account: ResolvedFeishuAccount,
): FeishuWebhookResult {
  try {
    // Handle URL verification challenge
    if (isUrlVerification(body)) {
      return handleUrlVerification(body, account);
    }

    // Handle event callback
    if (isEventCallback(body)) {
      return handleEventCallback(body, account);
    }

    return { type: "unknown" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "error", error: message };
  }
}

/**
 * Check if the body is a URL verification request
 */
function isUrlVerification(body: unknown): body is FeishuUrlVerificationEvent {
  return (
    typeof body === "object" &&
    body !== null &&
    "type" in body &&
    (body as { type: string }).type === "url_verification"
  );
}

/**
 * Check if the body is an event callback
 */
function isEventCallback(body: unknown): body is { schema: string; header: { event_type: string } } {
  return (
    typeof body === "object" &&
    body !== null &&
    "schema" in body &&
    "header" in body &&
    typeof (body as { header: unknown }).header === "object"
  );
}

/**
 * Handle URL verification challenge
 */
function handleUrlVerification(
  event: FeishuUrlVerificationEvent,
  account: ResolvedFeishuAccount,
): FeishuWebhookResult {
  // Verify token if configured
  if (account.verificationToken && event.token !== account.verificationToken) {
    return { type: "error", error: "Invalid verification token" };
  }

  return {
    type: "challenge",
    challenge: event.challenge,
  };
}

/**
 * Handle event callback
 */
function handleEventCallback(
  body: { schema: string; header: { event_type: string }; event?: unknown },
  account: ResolvedFeishuAccount,
): FeishuWebhookResult {
  const eventType = body.header.event_type;

  switch (eventType) {
    case "im.message.receive_v1":
      return handleMessageReceive(body as FeishuMessageReceiveEvent, account);

    case "im.chat.member.bot.added_v1":
      return handleBotAdded(body as FeishuBotAddedEvent);

    case "im.chat.member.bot.deleted_v1":
      return handleBotRemoved(body as FeishuBotRemovedEvent);

    default:
      return { type: "unknown" };
  }
}

/**
 * Handle message receive event
 */
function handleMessageReceive(
  event: FeishuMessageReceiveEvent,
  _account: ResolvedFeishuAccount,
): FeishuWebhookResult {
  const { sender, message } = event.event;

  // Parse message content
  let text: string | undefined;
  let imageKey: string | undefined;
  let fileKey: string | undefined;
  let fileName: string | undefined;

  try {
    const contentObj = JSON.parse(message.content);

    switch (message.message_type) {
      case "text":
        text = contentObj.text;
        break;

      case "post":
        // Extract text from post content
        text = extractTextFromPost(contentObj);
        break;

      case "image":
        // Image message: { image_key: "xxx" }
        imageKey = contentObj.image_key;
        text = "<media:image>";
        break;

      case "file":
        // File message: { file_key: "xxx", file_name: "xxx" }
        fileKey = contentObj.file_key;
        fileName = contentObj.file_name;
        text = `<media:file>${fileName ?? "file"}`;
        break;

      case "audio":
        // Audio message: { file_key: "xxx", duration: xxx }
        fileKey = contentObj.file_key;
        text = `<media:audio>`;
        break;

      case "media":
        // Media message (video): { file_key: "xxx", image_key: "xxx" }
        fileKey = contentObj.file_key;
        imageKey = contentObj.image_key;
        text = `<media:video>`;
        break;

      case "sticker":
        // Sticker message: { file_key: "xxx" }
        fileKey = contentObj.file_key;
        text = `<media:sticker>`;
        break;

      case "interactive":
        // Card message - extract text from elements
        text = extractTextFromCard(contentObj);
        break;

      case "share_chat":
        // Shared chat: { chat_id: "xxx" }
        text = `[Shared chat: ${contentObj.chat_id}]`;
        break;

      case "share_user":
        // Shared user: { user_id: "xxx" }
        text = `[Shared user: ${contentObj.user_id}]`;
        break;

      default:
        // Unknown message type - try to extract as text
        text = message.content;
    }
  } catch {
    // Content might not be JSON
    text = message.content;
  }

  // Map mentions
  const mentions = message.mentions?.map((m) => ({
    key: m.key,
    id: m.id.open_id || m.id.user_id || m.id.union_id || "",
    name: m.name,
  }));

  // Generate display text with mention placeholders replaced
  let displayText = text;
  if (text && mentions && mentions.length > 0) {
    for (const mention of mentions) {
      displayText = displayText?.replace(new RegExp(mention.key, "g"), `@${mention.name}`);
    }
  }

  const inboundMessage: FeishuInboundMessage = {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === "p2p" ? "direct" : "group",
    senderId: sender.sender_id.open_id || sender.sender_id.user_id || sender.sender_id.union_id || "",
    senderOpenId: sender.sender_id.open_id,
    senderUserId: sender.sender_id.user_id,
    senderUnionId: sender.sender_id.union_id,
    messageType: message.message_type,
    content: message.content,
    text,
    displayText,
    mentions,
    rootId: message.root_id,
    parentId: message.parent_id,
    createTime: parseInt(message.create_time, 10),
    tenantKey: sender.tenant_key,
    // Media fields
    imageKey,
    fileKey,
    fileName,
  };

  return {
    type: "message",
    message: inboundMessage,
  };
}

/**
 * Extract text from interactive card content
 */
function extractTextFromCard(content: unknown): string {
  const texts: string[] = [];

  if (typeof content !== "object" || content === null) {
    return "";
  }

  const card = content as {
    header?: { title?: { content?: string } };
    elements?: Array<{ tag?: string; content?: string; text?: { content?: string } }>;
  };

  // Extract header title
  if (card.header?.title?.content) {
    texts.push(card.header.title.content);
  }

  // Extract element contents
  if (Array.isArray(card.elements)) {
    for (const element of card.elements) {
      if (element.tag === "markdown" && element.content) {
        texts.push(element.content);
      } else if (element.tag === "div" && element.text?.content) {
        texts.push(element.text.content);
      }
    }
  }

  return texts.join("\n");
}

/**
 * Handle bot added to chat event
 */
function handleBotAdded(event: FeishuBotAddedEvent): FeishuWebhookResult {
  return {
    type: "bot_added",
    chatId: event.event.chat_id,
  };
}

/**
 * Handle bot removed from chat event
 */
function handleBotRemoved(event: FeishuBotRemovedEvent): FeishuWebhookResult {
  return {
    type: "bot_removed",
    chatId: event.event.chat_id,
  };
}

/**
 * Extract plain text from post content
 * Supports multiple formats:
 * - { zh_cn: { title, content } } - with language tag
 * - { title, content } - direct format (common in received messages)
 * - { post: { zh_cn: { ... } } } - nested post field
 */
function extractTextFromPost(content: unknown): string {
  const texts: string[] = [];

  function extractFromElements(elements: unknown[]): void {
    for (const element of elements) {
      if (typeof element !== "object" || element === null) {
        continue;
      }

      const el = element as { tag?: string; text?: string; user_name?: string };

      if ((el.tag === "text" || el.tag === "a") && el.text) {
        texts.push(el.text);
      } else if (el.tag === "at" && el.user_name) {
        texts.push(`@${el.user_name}`);
      }
    }
  }

  if (typeof content !== "object" || content === null) {
    return "";
  }

  const obj = content as Record<string, unknown>;

  let postContent: unknown[][] | undefined;
  let title: string | undefined;

  // Format 1: { zh_cn/en_us: { title, content } }
  const langPost = (obj.zh_cn || obj.en_us) as { title?: string; content?: unknown[][] } | undefined;
  if (langPost?.content) {
    postContent = langPost.content;
    title = langPost.title;
  }

  // Format 2: { title, content } - direct format
  if (!postContent && Array.isArray(obj.content)) {
    postContent = obj.content as unknown[][];
    title = obj.title as string | undefined;
  }

  // Format 3: { post: { zh_cn: { ... } } }
  if (!postContent && obj.post) {
    const nested = obj.post as Record<string, unknown>;
    const nestedLang = (nested.zh_cn || nested.en_us) as { title?: string; content?: unknown[][] } | undefined;
    if (nestedLang?.content) {
      postContent = nestedLang.content;
      title = nestedLang.title;
    }
  }

  // Extract title
  if (title) {
    texts.push(title);
  }

  // Extract content
  if (Array.isArray(postContent)) {
    for (const line of postContent) {
      if (Array.isArray(line)) {
        extractFromElements(line);
      }
    }
  }

  return texts.join(" ");
}

/**
 * Verify webhook request signature
 */
export function verifySignature(
  timestamp: string,
  nonce: string,
  signature: string,
  body: string,
  encryptKey: string,
): boolean {
  // Feishu webhook signature verification
  // signature = sha256(timestamp + nonce + encryptKey + body)
  // For now, we'll implement basic verification
  // TODO: Implement proper HMAC-SHA256 verification

  if (!encryptKey) {
    return true; // No encryption configured, skip verification
  }

  // Placeholder for actual verification
  return true;
}

/**
 * Decrypt encrypted webhook body
 */
export function decryptBody(encryptedBody: string, encryptKey: string): string {
  // Feishu uses AES-256-CBC for encryption
  // The encrypted body is base64 encoded
  // TODO: Implement proper AES decryption

  if (!encryptKey) {
    return encryptedBody;
  }

  // Placeholder for actual decryption
  return encryptedBody;
}

/**
 * Create the challenge response for URL verification
 */
export function createChallengeResponse(challenge: string): { challenge: string } {
  return { challenge };
}

/**
 * Check if a message mentions the bot
 * @param message - The inbound message
 * @param botOpenId - The bot's open_id (optional)
 * @param botName - The bot's name to match (optional, e.g., "OpenClaw")
 */
export function isBotMentioned(
  message: FeishuInboundMessage,
  botOpenId?: string,
  botName?: string,
): boolean {
  if (!message.mentions || message.mentions.length === 0) {
    return false;
  }

  return message.mentions.some((m) => {
    // Check by open_id
    if (botOpenId && m.id === botOpenId) {
      return true;
    }
    // Check by name
    if (botName && m.name === botName) {
      return true;
    }
    // Check for @all
    if (m.key === "@_all") {
      return true;
    }
    return false;
  });
}

/**
 * Get the text content without the bot mention
 * Removes the @bot placeholder and cleans up whitespace
 */
export function getTextWithoutBotMention(
  text: string,
  mentions: Array<{ key: string; name: string; id: string }> | undefined,
  botOpenId?: string,
  botName?: string,
): string {
  if (!text || !mentions || mentions.length === 0) {
    return text;
  }

  let result = text;

  for (const mention of mentions) {
    const isBotMention =
      (botOpenId && mention.id === botOpenId) ||
      (botName && mention.name === botName);

    if (isBotMention) {
      // Remove bot mention
      result = result.replace(new RegExp(mention.key, "g"), "");
    } else {
      // Replace other mentions with @name
      result = result.replace(new RegExp(mention.key, "g"), `@${mention.name}`);
    }
  }

  // Clean up extra whitespace
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Strip bot mention from message text
 */
export function stripBotMention(
  text: string,
  mentions: Array<{ key: string; name: string }> | undefined,
  _botOpenId?: string,
): string {
  if (!text || !mentions || mentions.length === 0) {
    return text;
  }

  let result = text;

  for (const mention of mentions) {
    // Replace mention placeholders like @_user_1
    result = result.replace(new RegExp(mention.key, "g"), "").trim();
  }

  return result;
}

/**
 * Replace mention placeholders with actual names
 * e.g., "@_user_1 hello" -> "@张三 hello"
 */
export function replaceMentionPlaceholders(
  text: string,
  mentions: Array<{ key: string; name: string }> | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) {
    return text;
  }

  let result = text;

  for (const mention of mentions) {
    // Replace @_user_1 with @实际名称
    result = result.replace(new RegExp(mention.key, "g"), `@${mention.name}`);
  }

  return result;
}

/**
 * Format text for display, replacing all mention placeholders
 */
export function formatMessageText(
  text: string,
  mentions: Array<{ key: string; name: string }> | undefined,
): string {
  return replaceMentionPlaceholders(text, mentions);
}
