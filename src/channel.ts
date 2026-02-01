/**
 * Feishu channel plugin implementation
 */

import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  loadWebMedia,
} from "openclaw/plugin-sdk";

import type {
  ResolvedFeishuAccount,
  FeishuChannelConfig,
  FeishuAccountConfig,
  FeishuDomain,
  FeishuConnectionMode,
  FeishuRenderMode,
} from "./types.js";
import * as api from "./api.js";
import { hasValidCredentials } from "./auth.js";
import { createWSClient, type FeishuWSClient } from "./websocket.js";
import { parseWebhookEvent, type FeishuInboundMessage } from "./webhook.js";
import { createFeishuDedupeCache } from "./dedupe.js";
import { createGroupHistoryManager, type HistoryEntry } from "./history.js";
import { buildFeishuMessageContext } from "./context.js";
import { dispatchFeishuMessage, createDefaultReplySender, createDefaultMediaSender } from "./dispatch.js";

// ============ Helper Functions ============

/**
 * Fetch reply context if message is a reply
 */
async function fetchReplyContext(
  account: ResolvedFeishuAccount,
  inbound: FeishuInboundMessage,
  log?: { warn?: (msg: string) => void },
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

// Channel metadata
const meta: ChannelMeta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu (飞书)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "Feishu/Lark enterprise messaging platform",
  order: 75,
  quickstartAllowFrom: true,
};

// Channel capabilities
const capabilities: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  reactions: false, // Feishu has limited reaction support
  threads: false, // No native thread support in the same way as Slack
  media: true,
  nativeCommands: false,
};

// ============ Account Resolution ============

function getFeishuConfig(cfg: OpenClawConfig): FeishuChannelConfig | undefined {
  return (cfg.channels as Record<string, unknown>)?.feishu as FeishuChannelConfig | undefined;
}

function listFeishuAccountIds(cfg: OpenClawConfig): string[] {
  const feishuConfig = getFeishuConfig(cfg);
  if (!feishuConfig) {
    return [];
  }

  const accountIds: string[] = [];

  // Check if default account has credentials
  if (feishuConfig.appId || feishuConfig.appSecret) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  // Add named accounts
  if (feishuConfig.accounts) {
    for (const accountId of Object.keys(feishuConfig.accounts)) {
      if (!accountIds.includes(accountId)) {
        accountIds.push(accountId);
      }
    }
  }

  return accountIds;
}

/** Get API base URL for the domain */
function getApiBase(domain: FeishuDomain): string {
  return domain === "lark"
    ? "https://open.larksuite.com/open-apis"
    : "https://open.feishu.cn/open-apis";
}

/** Get WebSocket URL for the domain */
function getWsUrl(domain: FeishuDomain): string {
  return domain === "lark"
    ? "wss://open.larksuite.com/open-apis/ws/v1"
    : "wss://open.feishu.cn/open-apis/ws/v1";
}

function resolveFeishuAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const { cfg, accountId: rawAccountId } = params;
  const accountId = normalizeAccountId(rawAccountId ?? DEFAULT_ACCOUNT_ID);
  const feishuConfig = getFeishuConfig(cfg);

  // Get account-specific config
  const accountConfig = feishuConfig?.accounts?.[accountId];
  const isNamedAccount = accountId !== DEFAULT_ACCOUNT_ID;

  // Resolve credentials - check account config first, then fall back to base config
  const appId = accountConfig?.appId ?? (isNamedAccount ? undefined : feishuConfig?.appId);
  const appSecret = accountConfig?.appSecret ?? (isNamedAccount ? undefined : feishuConfig?.appSecret);

  // Check environment variables as fallback
  const envAppId = process.env.FEISHU_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET;

  const resolvedAppId = appId ?? (accountId === DEFAULT_ACCOUNT_ID ? envAppId : undefined);
  const resolvedAppSecret = appSecret ?? (accountId === DEFAULT_ACCOUNT_ID ? envAppSecret : undefined);

  // Determine credential sources
  const appIdSource = appId ? "config" : (resolvedAppId ? "env" : "none");
  const appSecretSource = appSecret ? "config" : (resolvedAppSecret ? "env" : "none");

  // Resolve domain and connection mode
  const domain: FeishuDomain = accountConfig?.domain ?? feishuConfig?.domain ?? "feishu";
  const connectionMode: FeishuConnectionMode = accountConfig?.connectionMode ?? feishuConfig?.connectionMode ?? "websocket";
  const renderMode: FeishuRenderMode = accountConfig?.renderMode ?? feishuConfig?.renderMode ?? "auto";
  const requireMention = accountConfig?.requireMention ?? feishuConfig?.requireMention ?? true;

  // Merge configuration
  const config: FeishuAccountConfig = {
    appId: resolvedAppId,
    appSecret: resolvedAppSecret,
    domain,
    connectionMode,
    webhookPath: accountConfig?.webhookPath ?? feishuConfig?.webhookPath,
    verificationToken: accountConfig?.verificationToken ?? feishuConfig?.verificationToken,
    encryptKey: accountConfig?.encryptKey ?? feishuConfig?.encryptKey,
    dmPolicy: accountConfig?.dmPolicy ?? feishuConfig?.dmPolicy ?? "pairing",
    allowFrom: accountConfig?.allowFrom ?? feishuConfig?.allowFrom,
    groupPolicy: accountConfig?.groupPolicy ?? feishuConfig?.groupPolicy ?? "allowlist",
    requireMention,
    mediaMaxMb: accountConfig?.mediaMaxMb ?? feishuConfig?.mediaMaxMb ?? 30,
    renderMode,
    groups: accountConfig?.groups ?? feishuConfig?.groups,
  };

  // Determine if account is enabled
  const enabled = accountConfig?.enabled ?? feishuConfig?.enabled ?? false;

  // Determine if account is configured
  const configured = Boolean(resolvedAppId && resolvedAppSecret);

  return {
    accountId,
    name: accountConfig?.name,
    enabled,
    configured,
    appId: resolvedAppId,
    appSecret: resolvedAppSecret,
    appIdSource,
    appSecretSource,
    apiBase: getApiBase(domain),
    wsUrl: getWsUrl(domain),
    domain,
    connectionMode,
    webhookPath: config.webhookPath,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
    renderMode,
    requireMention,
    config,
  };
}

function resolveDefaultFeishuAccountId(cfg: OpenClawConfig): string {
  const accountIds = listFeishuAccountIds(cfg);
  return accountIds.length > 0 ? accountIds[0] : DEFAULT_ACCOUNT_ID;
}

// ============ Media Helpers ============

/**
 * Resolve Feishu file type from MIME type
 */
function resolveFeishuFileType(contentType: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const mimeMap: Record<string, "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"> = {
    "audio/opus": "opus",
    "audio/ogg": "opus",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt",
  };

  return mimeMap[contentType] ?? "stream";
}

// ============ Target Normalization ============

function normalizeFeishuMessagingTarget(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();

  // Already a chat_id or open_id format
  if (trimmed.startsWith("oc_") || trimmed.startsWith("ou_")) {
    return trimmed;
  }

  // Handle feishu: prefix
  if (trimmed.toLowerCase().startsWith("feishu:")) {
    return trimmed.slice(7).trim();
  }

  // Handle chat: prefix
  if (trimmed.toLowerCase().startsWith("chat:")) {
    return trimmed.slice(5).trim();
  }

  // Handle user: prefix
  if (trimmed.toLowerCase().startsWith("user:")) {
    return trimmed.slice(5).trim();
  }

  return trimmed;
}

function looksLikeFeishuTargetId(raw: string, normalized?: string): boolean {
  const id = normalized ?? raw;
  // Feishu IDs typically start with oc_ (chat) or ou_ (user)
  return id.startsWith("oc_") || id.startsWith("ou_");
}

// ============ Channel Plugin ============

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta,
  capabilities,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.feishu"] },

  // Configuration adapter
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        clearBaseFields: ["appId", "appSecret", "webhookPath", "verificationToken", "encryptKey", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      appIdSource: account.appIdSource,
      appSecretSource: account.appSecretSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFeishuAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  // Pairing adapter
  pairing: {
    idLabel: "feishuUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^feishu:/i, ""),
    notifyApproval: async ({ id, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      if (hasValidCredentials(account)) {
        await api.sendText(account, id, PAIRING_APPROVED_MESSAGE, { receiveIdType: "open_id" });
      }
    },
  },

  // Security adapter
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const feishuConfig = getFeishuConfig(cfg);
      const useAccountPath = Boolean(feishuConfig?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.feishu.accounts.${resolvedAccountId}.`
        : "channels.feishu.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("feishu"),
        normalizeEntry: (raw) => raw.replace(/^feishu:/i, "").trim(),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = (cfg.channels as Record<string, { groupPolicy?: string }>)?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

      if (groupPolicy === "open") {
        warnings.push(
          `- Feishu groups: groupPolicy="open" allows any group member to trigger the bot. Set channels.feishu.groupPolicy="allowlist" to restrict access.`,
        );
      }

      return warnings;
    },
  },

  // Messaging adapter
  messaging: {
    normalizeTarget: normalizeFeishuMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeFeishuTargetId,
      hint: "<chat_id|open_id|feishu:ID>",
    },
  },

  // Setup adapter
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "feishu",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      // Check for app credentials
      const hasAppId = Boolean(input.token || input.useEnv);
      const hasAppSecret = Boolean(input.tokenFile || input.useEnv);

      if (!hasAppId && !hasAppSecret && !input.useEnv) {
        return "Feishu requires --app-id and --app-secret (or --use-env with FEISHU_APP_ID and FEISHU_APP_SECRET).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "feishu",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "feishu",
            })
          : namedConfig;

      const feishuUpdate: Record<string, unknown> = {
        ...(next.channels as Record<string, unknown>)?.feishu,
        enabled: true,
      };

      if (!input.useEnv) {
        if (input.token) {
          feishuUpdate.appId = input.token;
        }
        if (input.tokenFile) {
          feishuUpdate.appSecret = input.tokenFile;
        }
      }

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...(next.channels as Record<string, unknown>),
            feishu: feishuUpdate,
          },
        };
      }

      const existingAccounts = (feishuUpdate as { accounts?: Record<string, unknown> }).accounts;
      return {
        ...next,
        channels: {
          ...(next.channels as Record<string, unknown>),
          feishu: {
            ...feishuUpdate,
            accounts: {
              ...existingAccounts,
              [accountId]: {
                ...existingAccounts?.[accountId],
                enabled: true,
                ...(input.token ? { appId: input.token } : {}),
                ...(input.tokenFile ? { appSecret: input.tokenFile } : {}),
              },
            },
          },
        },
      };
    },
  },

  // Outbound adapter
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });

      if (!hasValidCredentials(account)) {
        return {
          channel: "feishu",
          ok: false,
          error: "Feishu account not configured (missing appId or appSecret)",
        };
      }

      // Determine receive_id_type based on target format
      const receiveIdType = to.startsWith("ou_") ? "open_id" : "chat_id";

      const result = await api.sendText(account, to, text, {
        receiveIdType,
        replyToId: replyToId ?? undefined,
      });

      return {
        channel: "feishu",
        ok: result.ok,
        messageId: result.messageId,
        error: result.error,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });

      if (!hasValidCredentials(account)) {
        return {
          channel: "feishu",
          ok: false,
          error: "Feishu account not configured (missing appId or appSecret)",
        };
      }

      const receiveIdType = to.startsWith("ou_") ? "open_id" : "chat_id";
      const mediaMaxBytes = (account.config.mediaMaxMb ?? 30) * 1024 * 1024;

      // If no media URL, just send text
      if (!mediaUrl) {
        const result = await api.sendText(account, to, text, {
          receiveIdType,
          replyToId: replyToId ?? undefined,
        });
        return {
          channel: "feishu",
          ok: result.ok,
          messageId: result.messageId,
          error: result.error,
        };
      }

      try {
        // Load media from URL or local path
        const media = await loadWebMedia(mediaUrl, mediaMaxBytes);

        if (!media.ok) {
          // Fallback to sending URL as text
          const messageText = text ? `${text}\n\n${mediaUrl}` : mediaUrl;
          const result = await api.sendText(account, to, messageText, {
            receiveIdType,
            replyToId: replyToId ?? undefined,
          });
          return {
            channel: "feishu",
            ok: result.ok,
            messageId: result.messageId,
            error: media.error,
          };
        }

        // Determine if it's an image based on content type
        const isImage = media.contentType?.startsWith("image/") ?? false;
        const fileName = media.fileName ?? "file";

        // Send caption text first if provided
        if (text) {
          await api.sendText(account, to, text, {
            receiveIdType,
            replyToId: replyToId ?? undefined,
          });
        }

        if (isImage) {
          // Upload and send image
          const uploadResult = await api.uploadImage(account, media.buffer, fileName);
          if (!uploadResult.ok || !uploadResult.imageKey) {
            return {
              channel: "feishu",
              ok: false,
              error: uploadResult.error ?? "Failed to upload image",
            };
          }

          const sendResult = await api.sendImage(account, to, uploadResult.imageKey, {
            receiveIdType,
            replyToId: text ? undefined : replyToId ?? undefined,
          });
          return {
            channel: "feishu",
            ok: sendResult.ok,
            messageId: sendResult.messageId,
            error: sendResult.error,
          };
        } else {
          // Upload and send file
          // Determine file type for Feishu API
          const fileType = resolveFeishuFileType(media.contentType ?? "application/octet-stream");
          const uploadResult = await api.uploadFile(account, media.buffer, fileName, fileType);

          if (!uploadResult.ok || !uploadResult.fileKey) {
            return {
              channel: "feishu",
              ok: false,
              error: uploadResult.error ?? "Failed to upload file",
            };
          }

          const sendResult = await api.sendFile(account, to, uploadResult.fileKey, {
            receiveIdType,
            replyToId: text ? undefined : replyToId ?? undefined,
          });
          return {
            channel: "feishu",
            ok: sendResult.ok,
            messageId: sendResult.messageId,
            error: sendResult.error,
          };
        }
      } catch (err) {
        // Fallback to sending URL as text on error
        const messageText = text ? `${text}\n\n${mediaUrl}` : mediaUrl;
        const result = await api.sendText(account, to, messageText, {
          receiveIdType,
          replyToId: replyToId ?? undefined,
        });
        return {
          channel: "feishu",
          ok: result.ok,
          messageId: result.messageId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },

  // Status adapter
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "feishu",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      appIdSource: snapshot.appIdSource ?? "none",
      appSecretSource: snapshot.appSecretSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      if (!hasValidCredentials(account)) {
        return { ok: false, error: "missing credentials" };
      }
      return await api.probeFeishu(account, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      appIdSource: account.appIdSource,
      appSecretSource: account.appSecretSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  // Gateway adapter
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const connectionMode = account.connectionMode;
      const logPrefix = `[${account.accountId}]`;

      ctx.log?.info(`${logPrefix} starting Feishu provider (mode: ${connectionMode})`);

      // Set initial status
      ctx.setStatus({
        accountId: account.accountId,
        configured: account.configured,
        appIdSource: account.appIdSource,
        appSecretSource: account.appSecretSource,
        connectionMode,
        running: true,
        lastStartAt: Date.now(),
      });

      if (!hasValidCredentials(account)) {
        ctx.log?.error(`${logPrefix} Feishu credentials not configured`);
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: "Credentials not configured",
        });
        return;
      }

      // Probe the API to verify credentials and get bot info
      const probe = await api.probeFeishu(account);
      if (!probe.ok) {
        ctx.log?.error(`${logPrefix} Feishu API probe failed: ${probe.error}`);
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: probe.error,
        });
        return;
      }

      // Get bot's open_id/name for mention detection
      const botOpenId = (probe as { bot?: { open_id?: string } }).bot?.open_id;
      const botName = (probe as { bot?: { app_name?: string } }).bot?.app_name;
      if (!botOpenId && !botName) {
        ctx.log?.warn(`${logPrefix} bot identity unavailable; mention detection may be limited`);
      }

      // Initialize message deduplication cache
      const dedupe = createFeishuDedupeCache();

      // Initialize group history manager
      const history = createGroupHistoryManager();

      // Note: Reply senders are created inside handleInboundMessage
      // because they need chatId which is only available at message time

      /**
       * Handle inbound message - build context, dispatch to agent, send reply
       */
      async function handleInboundMessage(inbound: FeishuInboundMessage): Promise<void> {
        // Deduplication check
        if (dedupe.isProcessed(inbound.messageId)) {
          ctx.log?.debug(`${logPrefix} skipping duplicate message: ${inbound.messageId}`);
          return;
        }
        dedupe.markProcessed(inbound.messageId);

        ctx.log?.info(`${logPrefix} received: ${inbound.text?.slice(0, 50)}...`);
        ctx.setStatus({ ...ctx.getStatus(), lastInboundAt: Date.now() });

        // Fetch reply context if this is a reply
        const messageWithContext = await fetchReplyContext(account, inbound, ctx.log);

        // Prepare group history
        const isGroup = inbound.chatType === "group";
        const historyEntry: HistoryEntry | undefined = isGroup
          ? {
              sender: inbound.senderOpenId ?? inbound.senderId,
              body: inbound.displayText ?? inbound.text ?? "",
              timestamp: inbound.createTime,
              messageId: inbound.messageId,
            }
          : undefined;

        // Get pending history for context
        const pendingHistory = isGroup ? history.get(inbound.chatId) : [];

        try {
          // Build message context using local module
          const context = await buildFeishuMessageContext({
            message: messageWithContext,
            account,
            cfg: ctx.cfg,
            botOpenId,
            botName,
            pendingHistory,
          });

          if (!context) {
            // Not a direct message to bot - record to history for future context
            if (historyEntry) {
              history.record(inbound.chatId, historyEntry);
            }
            ctx.log?.debug(`${logPrefix} message blocked by policy`);
            return;
          }

          // Create reply senders with chatId for this message
          const sendReply = createDefaultReplySender(account, inbound.chatId, isGroup);
          const sendMedia = createDefaultMediaSender(account, inbound.chatId, isGroup);

          // Dispatch to agent using local module
          await dispatchFeishuMessage({
            context,
            cfg: ctx.cfg,
            onSendReply: async (params) => {
              const result = await sendReply(params);
              ctx.setStatus({ ...ctx.getStatus(), lastOutboundAt: Date.now() });
              return result;
            },
            onSendMedia: async (params) => {
              const result = await sendMedia(params);
              ctx.setStatus({ ...ctx.getStatus(), lastOutboundAt: Date.now() });
              return result;
            },
          });

          // Clear group history after bot replies
          if (isGroup) {
            history.clear(inbound.chatId);
          }
        } catch (err) {
          ctx.log?.error(`${logPrefix} message handling failed: ${String(err)}`);
        }
      }

      // WebSocket mode: establish long connection
      if (connectionMode === "websocket") {
        let wsClient: FeishuWSClient | null = null;

        try {
          wsClient = await createWSClient({
            account,
            onMessage: async (event) => {
              ctx.log?.debug(`${logPrefix} received message via WebSocket`);
              const result = parseWebhookEvent(event, account);
              if (result.type === "message" && result.message) {
                await handleInboundMessage(result.message as FeishuInboundMessage);
              }
            },
            onStateChange: (state) => {
              ctx.log?.info(`${logPrefix} WebSocket state: ${state}`);
              ctx.setStatus({
                ...ctx.getStatus(),
                wsState: state,
                running: state === "connected" || state === "reconnecting",
              });
            },
            onError: (error) => {
              ctx.log?.error(`${logPrefix} WebSocket error: ${error.message}`);
            },
          });

          await wsClient.start();
          ctx.log?.info(`${logPrefix} Feishu WebSocket connected`);

          // Keep running until abort
          return new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener("abort", async () => {
              ctx.log?.info(`${logPrefix} stopping Feishu WebSocket`);
              if (wsClient) {
                await wsClient.stop();
              }
              ctx.setStatus({
                ...ctx.getStatus(),
                running: false,
                wsState: "disconnected",
                lastStopAt: Date.now(),
              });
              resolve();
            });
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          ctx.log?.error(`${logPrefix} WebSocket connection failed: ${errorMsg}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastError: `WebSocket: ${errorMsg}`,
          });

          // Fall back to webhook mode if WebSocket fails
          ctx.log?.info(`${logPrefix} falling back to webhook mode`);
        }
      }

      // Webhook mode: wait for incoming HTTP requests
      ctx.log?.info(`${logPrefix} Feishu provider started in webhook mode`);

      // Keep the gateway running until abort
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          ctx.log?.info(`${logPrefix} Feishu provider stopping`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: Date.now(),
          });
          resolve();
        });
      });
    },
  },
};
