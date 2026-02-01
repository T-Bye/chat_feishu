/**
 * Feishu API wrapper for messaging
 */

import type {
  FeishuApiResponse,
  FeishuSendMessageRequest,
  FeishuSendMessageResponse,
  FeishuReceiveIdType,
  FeishuMsgType,
  FeishuTextContent,
  FeishuPostContent,
  FeishuInteractiveContent,
  ResolvedFeishuAccount,
  FeishuSendResult,
  FeishuSendOptions,
  FeishuRenderMode,
} from "./types.js";
import { getTenantAccessToken, invalidateToken } from "./auth.js";

/** Get API base URL for an account */
function getApiBase(account: ResolvedFeishuAccount): string {
  return account.apiBase || "https://open.feishu.cn/open-apis";
}

/**
 * Make an authenticated API request to Feishu
 */
async function feishuRequest<T>(
  account: ResolvedFeishuAccount,
  method: string,
  endpoint: string,
  body?: unknown,
  queryParams?: Record<string, string>,
  retryOnAuthError = true,
): Promise<FeishuApiResponse<T>> {
  const token = await getTenantAccessToken(account);
  const apiBase = getApiBase(account);

  let url = `${apiBase}${endpoint}`;
  if (queryParams) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as FeishuApiResponse<T>;

  // Handle token expiration
  if (data.code === 99991663 || data.code === 99991664) {
    if (retryOnAuthError) {
      invalidateToken(account.accountId);
      return feishuRequest(account, method, endpoint, body, queryParams, false);
    }
  }

  return data;
}

/**
 * Send a message to Feishu
 */
async function sendMessage(
  account: ResolvedFeishuAccount,
  receiveId: string,
  msgType: FeishuMsgType,
  content: string,
  receiveIdType: FeishuReceiveIdType = "chat_id",
  replyToId?: string,
): Promise<FeishuSendResult> {
  const body: FeishuSendMessageRequest = {
    receive_id: receiveId,
    msg_type: msgType,
    content,
    uuid: generateUuid(),
  };

  const endpoint = replyToId
    ? `/im/v1/messages/${replyToId}/reply`
    : "/im/v1/messages";

  const queryParams = replyToId ? undefined : { receive_id_type: receiveIdType };

  const response = await feishuRequest<FeishuSendMessageResponse>(
    account,
    "POST",
    endpoint,
    body,
    queryParams,
  );

  if (response.code !== 0) {
    return {
      ok: false,
      error: `Feishu API error: ${response.code} - ${response.msg}`,
    };
  }

  return {
    ok: true,
    messageId: response.data?.message_id,
  };
}

/**
 * Send a text message
 */
export async function sendText(
  account: ResolvedFeishuAccount,
  receiveId: string,
  text: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const content: FeishuTextContent = { text };
  return sendMessage(
    account,
    receiveId,
    "text",
    JSON.stringify(content),
    options.receiveIdType ?? "chat_id",
    options.replyToId,
  );
}

/**
 * Send a rich text (post) message
 */
export async function sendPost(
  account: ResolvedFeishuAccount,
  receiveId: string,
  postContent: FeishuPostContent,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  return sendMessage(
    account,
    receiveId,
    "post",
    JSON.stringify(postContent),
    options.receiveIdType ?? "chat_id",
    options.replyToId,
  );
}

/**
 * Send an interactive card message
 */
export async function sendCard(
  account: ResolvedFeishuAccount,
  receiveId: string,
  cardContent: FeishuInteractiveContent,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  return sendMessage(
    account,
    receiveId,
    "interactive",
    JSON.stringify(cardContent),
    options.receiveIdType ?? "chat_id",
    options.replyToId,
  );
}

/**
 * Send an image message
 */
export async function sendImage(
  account: ResolvedFeishuAccount,
  receiveId: string,
  imageKey: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const content = { image_key: imageKey };
  return sendMessage(
    account,
    receiveId,
    "image",
    JSON.stringify(content),
    options.receiveIdType ?? "chat_id",
    options.replyToId,
  );
}

/**
 * Send a file message
 */
export async function sendFile(
  account: ResolvedFeishuAccount,
  receiveId: string,
  fileKey: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const content = { file_key: fileKey };
  return sendMessage(
    account,
    receiveId,
    "file",
    JSON.stringify(content),
    options.receiveIdType ?? "chat_id",
    options.replyToId,
  );
}

/**
 * Upload an image to Feishu and get the image_key
 */
export async function uploadImage(
  account: ResolvedFeishuAccount,
  imageBuffer: ArrayBuffer,
  imageName: string,
): Promise<{ ok: boolean; imageKey?: string; error?: string }> {
  const token = await getTenantAccessToken(account);
  const apiBase = getApiBase(account);

  const formData = new FormData();
  formData.append("image_type", "message");
  formData.append("image", new Blob([imageBuffer]), imageName);

  const response = await fetch(`${apiBase}/im/v1/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = (await response.json()) as FeishuApiResponse<{ image_key: string }>;

  if (data.code !== 0) {
    return {
      ok: false,
      error: `Failed to upload image: ${data.code} - ${data.msg}`,
    };
  }

  return {
    ok: true,
    imageKey: data.data?.image_key,
  };
}

/**
 * Upload a file to Feishu and get the file_key
 */
export async function uploadFile(
  account: ResolvedFeishuAccount,
  fileBuffer: ArrayBuffer,
  fileName: string,
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
): Promise<{ ok: boolean; fileKey?: string; error?: string }> {
  const token = await getTenantAccessToken(account);
  const apiBase = getApiBase(account);

  const formData = new FormData();
  formData.append("file_type", fileType);
  formData.append("file_name", fileName);
  formData.append("file", new Blob([fileBuffer]), fileName);

  const response = await fetch(`${apiBase}/im/v1/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = (await response.json()) as FeishuApiResponse<{ file_key: string }>;

  if (data.code !== 0) {
    return {
      ok: false,
      error: `Failed to upload file: ${data.code} - ${data.msg}`,
    };
  }

  return {
    ok: true,
    fileKey: data.data?.file_key,
  };
}

/**
 * Get chat information
 */
export async function getChatInfo(
  account: ResolvedFeishuAccount,
  chatId: string,
): Promise<FeishuApiResponse<{
  chat_id: string;
  name: string;
  description: string;
  owner_id: string;
  owner_id_type: string;
  chat_mode: string;
  chat_type: string;
  external: boolean;
}>> {
  return feishuRequest(account, "GET", `/im/v1/chats/${chatId}`);
}

/**
 * Get user info by user ID
 */
export async function getUserInfo(
  account: ResolvedFeishuAccount,
  userId: string,
  userIdType: "open_id" | "union_id" | "user_id" = "open_id",
): Promise<FeishuApiResponse<{
  user: {
    open_id: string;
    union_id: string;
    user_id: string;
    name: string;
    en_name: string;
    nickname: string;
    email: string;
    mobile: string;
    avatar: {
      avatar_72: string;
      avatar_240: string;
      avatar_640: string;
      avatar_origin: string;
    };
  };
}>> {
  return feishuRequest(account, "GET", `/contact/v3/users/${userId}`, undefined, {
    user_id_type: userIdType,
  });
}

/**
 * Test API connectivity (probe)
 */
export async function probeFeishu(
  account: ResolvedFeishuAccount,
  timeoutMs = 10000,
): Promise<{ ok: boolean; error?: string; bot?: { open_id: string; app_name?: string } }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const apiBase = getApiBase(account);

    // Validate credentials by fetching a token
    await getTenantAccessToken(account);

    const response = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: account.appId,
        app_secret: account.appSecret,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as FeishuApiResponse;

    if (data.code !== 0) {
      return { ok: false, error: data.msg };
    }

    // Get bot info for mention detection
    const botInfoResponse = await fetch(`${apiBase}/bot/v3/info`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${await getTenantAccessToken(account)}`,
      },
    });

    if (botInfoResponse.ok) {
      const botData = (await botInfoResponse.json()) as FeishuApiResponse<{
        app_name?: string;
        open_id?: string;
      }>;
      if (botData.code === 0 && botData.data?.open_id) {
        return { ok: true, bot: { open_id: botData.data.open_id, app_name: botData.data.app_name } };
      }
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Generate a UUID for message deduplication
 */
function generateUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Convert markdown to Feishu post format
 */
export function markdownToPost(markdown: string, title?: string): FeishuPostContent {
  const lines = markdown.split("\n");
  const content: Array<Array<{ tag: string; text?: string; href?: string }>> = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const elements: Array<{ tag: string; text?: string; href?: string }> = [];
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;

    while ((match = linkRegex.exec(line)) !== null) {
      // Add text before the link
      if (match.index > lastIndex) {
        elements.push({
          tag: "text",
          text: line.slice(lastIndex, match.index),
        });
      }

      // Add the link
      elements.push({
        tag: "a",
        text: match[1],
        href: match[2],
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < line.length) {
      elements.push({
        tag: "text",
        text: line.slice(lastIndex),
      });
    }

    if (elements.length > 0) {
      content.push(elements);
    }
  }

  return {
    zh_cn: {
      title,
      content,
    },
  };
}

// ============ Card Building Utilities ============

/** Supported card header colors */
export type CardColor =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey";

/** Options for building a card base */
export interface CardBaseOptions {
  /** Card title (optional) */
  title?: string;
  /** Header color (default: "blue") */
  color?: CardColor;
  /** Enable wide screen mode (default: true) */
  wideScreen?: boolean;
  /** Enable forward (default: undefined) */
  enableForward?: boolean;
}

/**
 * Build a base card structure with common configuration
 * Internal helper to reduce duplication in card creation functions
 */
function buildCardBase(options: CardBaseOptions = {}): FeishuInteractiveContent {
  const { title, color = "blue", wideScreen = true, enableForward } = options;

  const card: FeishuInteractiveContent = {
    config: {
      wide_screen_mode: wideScreen,
      ...(enableForward !== undefined && { enable_forward: enableForward }),
    },
    elements: [],
  };

  if (title) {
    card.header = {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: color,
    };
  }

  return card;
}

/**
 * Create a simple card message
 */
export function createSimpleCard(
  title: string,
  content: string,
  color: CardColor = "blue",
): FeishuInteractiveContent {
  const card = buildCardBase({ title, color });
  card.elements = [{ tag: "markdown", content }];
  return card;
}

/**
 * Create a markdown card without header (cleaner look)
 */
export function createMarkdownCard(content: string): FeishuInteractiveContent {
  const card = buildCardBase();
  card.elements = [{ tag: "markdown", content }];
  return card;
}

/**
 * Create a card with syntax-highlighted code block
 * Feishu supports language-specific code highlighting in markdown cards
 */
export function createCodeCard(
  code: string,
  language: string = "plaintext",
  title?: string,
): FeishuInteractiveContent {
  const card = buildCardBase({ title });
  card.elements = [{ tag: "markdown", content: `\`\`\`${language}\n${code}\n\`\`\`` }];
  return card;
}

/**
 * Create a card with a table
 * Feishu cards support markdown tables natively
 */
export function createTableCard(
  headers: string[],
  rows: string[][],
  title?: string,
): FeishuInteractiveContent {
  // Build markdown table
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataRows = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  const tableMarkdown = `${headerRow}\n${separator}\n${dataRows}`;

  const card = buildCardBase({ title });
  card.elements = [{ tag: "markdown", content: tableMarkdown }];
  return card;
}

/**
 * Button configuration for interactive cards
 */
export interface CardButton {
  /** Button display text */
  text: string;
  /** Button action value */
  value: string;
  /** Button style */
  type?: "primary" | "default" | "danger";
  /** Optional URL for link buttons */
  url?: string;
}

/**
 * Create a card with interactive buttons
 */
export function createCardWithButtons(
  content: string,
  buttons: CardButton[],
  title?: string,
): FeishuInteractiveContent {
  const card = buildCardBase({ title });
  card.elements = [
    { tag: "markdown", content },
    {
      tag: "action",
      actions: buttons.map((btn) => {
        if (btn.url) {
          return {
            tag: "button",
            text: { tag: "plain_text", content: btn.text },
            type: btn.type ?? "default",
            url: btn.url,
          };
        }
        return {
          tag: "button",
          text: { tag: "plain_text", content: btn.text },
          type: btn.type ?? "default",
          value: { action: btn.value },
        };
      }),
    },
  ];
  return card;
}

/**
 * Section configuration for multi-section cards
 */
export interface CardSection {
  /** Section type */
  type: "markdown" | "divider" | "note";
  /** Content for markdown sections */
  content?: string;
  /** Elements for note sections */
  elements?: Array<{ tag: string; content?: string }>;
}

/**
 * Create a multi-section card with dividers
 */
export function createMultiSectionCard(
  sections: CardSection[],
  title?: string,
  color?: CardColor,
): FeishuInteractiveContent {
  const card = buildCardBase({ title, color });
  card.elements = sections.map((section) => {
    if (section.type === "markdown" && section.content) {
      return { tag: "markdown", content: section.content };
    }
    if (section.type === "divider") {
      return { tag: "hr" };
    }
    if (section.type === "note" && section.elements) {
      return { tag: "note", elements: section.elements };
    }
    return { tag: "markdown", content: section.content ?? "" };
  });
  return card;
}

/**
 * Check if text contains code blocks, tables, or other rich content (should use card rendering)
 */
export function shouldUseCardRendering(text: string): boolean {
  // Check for code blocks (```code```)
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  // Check for tables (markdown table syntax)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) {
    return true;
  }
  // Check for markdown links [text](url)
  if (/\[.+\]\(.+\)/.test(text)) {
    return true;
  }
  // Check for long text (>500 chars) - better display in card
  if (text.length > 500) {
    return true;
  }
  // Check for multiple paragraphs
  if ((text.match(/\n\n/g) || []).length >= 3) {
    return true;
  }
  return false;
}

/**
 * Convert markdown table to ASCII art table (for raw mode)
 */
export function markdownTableToAscii(markdown: string): string {
  // Simple conversion - just clean up the markdown table syntax
  return markdown
    .replace(/\|/g, " | ")
    .replace(/[-:]+\|[-:| ]+/g, (match) => match.replace(/[:|]/g, "-"));
}

/**
 * Smart send - automatically choose between text and card based on content and renderMode
 */
export async function sendSmart(
  account: ResolvedFeishuAccount,
  receiveId: string,
  text: string,
  options: FeishuSendOptions & { renderMode?: FeishuRenderMode } = {},
): Promise<FeishuSendResult> {
  const renderMode = options.renderMode ?? account.renderMode ?? "auto";

  // Determine whether to use card rendering
  let useCard = false;
  let processedText = text;

  switch (renderMode) {
    case "card":
      useCard = true;
      break;
    case "raw":
      useCard = false;
      // Convert tables to ASCII for raw mode
      processedText = markdownTableToAscii(text);
      break;
    case "auto":
    default:
      useCard = shouldUseCardRendering(text);
      break;
  }

  if (useCard) {
    // Send as card message
    const card = createMarkdownCard(text);
    return sendCard(account, receiveId, card, options);
  } else {
    // Send as plain text
    return sendText(account, receiveId, processedText, options);
  }
}

/**
 * Get chat list that the bot is in
 */
export async function getChatList(
  account: ResolvedFeishuAccount,
  pageSize = 50,
  pageToken?: string,
): Promise<FeishuApiResponse<{
  items: Array<{
    chat_id: string;
    name: string;
    description?: string;
    chat_mode: string;
    chat_type: string;
    external: boolean;
    owner_id?: string;
  }>;
  page_token?: string;
  has_more: boolean;
}>> {
  const params: Record<string, string> = { page_size: String(pageSize) };
  if (pageToken) {
    params.page_token = pageToken;
  }
  return feishuRequest(account, "GET", "/im/v1/chats", undefined, params);
}

/**
 * Get chat members
 */
export async function getChatMembers(
  account: ResolvedFeishuAccount,
  chatId: string,
  pageSize = 50,
  pageToken?: string,
): Promise<FeishuApiResponse<{
  items: Array<{
    member_id: string;
    member_id_type: string;
    name?: string;
  }>;
  page_token?: string;
  has_more: boolean;
}>> {
  const params: Record<string, string> = { page_size: String(pageSize) };
  if (pageToken) {
    params.page_token = pageToken;
  }
  return feishuRequest(account, "GET", `/im/v1/chats/${chatId}/members`, undefined, params);
}

/**
 * Get message history from a chat
 */
export async function getMessageHistory(
  account: ResolvedFeishuAccount,
  chatId: string,
  pageSize = 20,
  startTime?: number,
  endTime?: number,
  pageToken?: string,
): Promise<FeishuApiResponse<{
  items: Array<{
    message_id: string;
    root_id?: string;
    parent_id?: string;
    msg_type: string;
    create_time: string;
    update_time?: string;
    deleted: boolean;
    chat_id: string;
    sender: {
      id: string;
      id_type: string;
      sender_type: string;
    };
    body: {
      content: string;
    };
  }>;
  page_token?: string;
  has_more: boolean;
}>> {
  const params: Record<string, string> = {
    container_id_type: "chat",
    container_id: chatId,
    page_size: String(pageSize),
  };
  if (startTime) {
    params.start_time = String(startTime);
  }
  if (endTime) {
    params.end_time = String(endTime);
  }
  if (pageToken) {
    params.page_token = pageToken;
  }
  return feishuRequest(account, "GET", "/im/v1/messages", undefined, params);
}

/**
 * Download image from Feishu
 */
export async function downloadImage(
  account: ResolvedFeishuAccount,
  imageKey: string,
): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> {
  try {
    const token = await getTenantAccessToken(account);
    const apiBase = getApiBase(account);

    const response = await fetch(`${apiBase}/im/v1/images/${imageKey}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.arrayBuffer();
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Download file from Feishu
 */
export async function downloadFile(
  account: ResolvedFeishuAccount,
  fileKey: string,
): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> {
  try {
    const token = await getTenantAccessToken(account);
    const apiBase = getApiBase(account);

    const response = await fetch(`${apiBase}/im/v1/files/${fileKey}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.arrayBuffer();
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Add reaction (emoji) to a message - used as typing indicator
 */
export async function addReaction(
  account: ResolvedFeishuAccount,
  messageId: string,
  emojiType: string,
): Promise<FeishuApiResponse<{ reaction_id: string }>> {
  return feishuRequest(
    account,
    "POST",
    `/im/v1/messages/${messageId}/reactions`,
    { reaction_type: { emoji_type: emojiType } },
  );
}

/**
 * Remove reaction from a message
 */
export async function removeReaction(
  account: ResolvedFeishuAccount,
  messageId: string,
  reactionId: string,
): Promise<FeishuApiResponse> {
  return feishuRequest(
    account,
    "DELETE",
    `/im/v1/messages/${messageId}/reactions/${reactionId}`,
  );
}

/**
 * Reply to a specific message
 */
export async function replyMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
  text: string,
  options: { renderMode?: FeishuRenderMode } = {},
): Promise<FeishuSendResult> {
  const renderMode = options.renderMode ?? account.renderMode ?? "auto";
  const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCardRendering(text));

  const msgType = useCard ? "interactive" : "text";
  const content = useCard
    ? JSON.stringify(createMarkdownCard(text))
    : JSON.stringify({ text });

  const body = {
    msg_type: msgType,
    content,
    uuid: generateUuid(),
  };

  const response = await feishuRequest<FeishuSendMessageResponse>(
    account,
    "POST",
    `/im/v1/messages/${messageId}/reply`,
    body,
  );

  if (response.code !== 0) {
    return { ok: false, error: `${response.code}: ${response.msg}` };
  }

  return { ok: true, messageId: response.data?.message_id };
}

/**
 * Send a rich text (post) message with @ mentions that are highlighted
 * This is the recommended way to @ someone in Feishu
 */
export async function sendPostWithMentions(
  account: ResolvedFeishuAccount,
  receiveId: string,
  text: string,
  mentions: Array<{ openId: string; name?: string }>,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const receiveIdType = options.receiveIdType ?? "chat_id";

  // Build content elements
  const elements: Array<{ tag: string; user_id?: string; text?: string }> = [];

  // Add @ mentions at the beginning
  for (const mention of mentions) {
    elements.push({
      tag: "at",
      user_id: mention.openId,
    });
    elements.push({
      tag: "text",
      text: " ",
    });
  }

  // Add the message text
  elements.push({
    tag: "text",
    text: text,
  });

  const postContent = {
    zh_cn: {
      content: [elements],
    },
  };

  const body: FeishuSendMessageRequest = {
    receive_id: receiveId,
    msg_type: "post",
    content: JSON.stringify(postContent),
    uuid: generateUuid(),
  };

  const response = await feishuRequest<FeishuSendMessageResponse>(
    account,
    "POST",
    "/im/v1/messages",
    body,
    { receive_id_type: receiveIdType },
  );

  if (response.code !== 0) {
    return { ok: false, error: `${response.code}: ${response.msg}` };
  }

  return { ok: true, messageId: response.data?.message_id };
}

/**
 * Send a reply that @mentions the sender
 * Automatically @ the person who sent the original message
 */
export async function sendReplyWithMention(
  account: ResolvedFeishuAccount,
  chatId: string,
  text: string,
  senderOpenId: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  return sendPostWithMentions(
    account,
    chatId,
    text,
    [{ openId: senderOpenId }],
    options,
  );
}

// ============ Message Retrieval ============

/**
 * Get a single message by ID
 * Used for fetching reply context (parent message content)
 */
export async function getMessage(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<{
  ok: boolean;
  message?: {
    messageId: string;
    msgType: string;
    content: string;
    senderId: string;
    senderType: string;
    chatId: string;
    createTime: string;
    body?: string;
  };
  error?: string;
}> {
  const response = await feishuRequest<{
    items: Array<{
      message_id: string;
      msg_type: string;
      create_time: string;
      chat_id: string;
      sender: {
        id: string;
        id_type: string;
        sender_type: string;
      };
      body: {
        content: string;
      };
    }>;
  }>(account, "GET", `/im/v1/messages/${messageId}`);

  if (response.code !== 0) {
    return {
      ok: false,
      error: `Failed to get message: ${response.code} - ${response.msg}`,
    };
  }

  const msg = response.data?.items?.[0];
  if (!msg) {
    return {
      ok: false,
      error: "Message not found",
    };
  }

  // Parse the content to extract text
  let textContent: string | undefined;
  try {
    const contentObj = JSON.parse(msg.body.content);
    if (msg.msg_type === "text") {
      textContent = contentObj.text;
    } else if (msg.msg_type === "post") {
      // Extract text from post content
      textContent = extractTextFromPostContent(contentObj);
    } else {
      textContent = msg.body.content;
    }
  } catch {
    textContent = msg.body.content;
  }

  return {
    ok: true,
    message: {
      messageId: msg.message_id,
      msgType: msg.msg_type,
      content: msg.body.content,
      senderId: msg.sender.id,
      senderType: msg.sender.sender_type,
      chatId: msg.chat_id,
      createTime: msg.create_time,
      body: textContent,
    },
  };
}

/**
 * Extract text from post content structure
 */
function extractTextFromPostContent(content: unknown): string {
  const texts: string[] = [];

  function extractFromElements(elements: unknown[]): void {
    for (const element of elements) {
      if (typeof element !== "object" || element === null) {
        continue;
      }

      const el = element as { tag?: string; text?: string };

      if (el.tag === "text" && el.text) {
        texts.push(el.text);
      } else if (el.tag === "a" && el.text) {
        texts.push(el.text);
      }
    }
  }

  if (typeof content === "object" && content !== null) {
    const post = content as {
      zh_cn?: { content?: unknown[][] };
      en_us?: { content?: unknown[][] };
    };

    const postContent = post.zh_cn?.content || post.en_us?.content;

    if (Array.isArray(postContent)) {
      for (const line of postContent) {
        if (Array.isArray(line)) {
          extractFromElements(line);
        }
      }
    }
  }

  return texts.join(" ");
}
