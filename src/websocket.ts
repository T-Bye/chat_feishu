/**
 * Feishu WebSocket long connection for receiving events
 *
 * Uses the official @larksuiteoapi/node-sdk for WebSocket support.
 * Benefits:
 * - No public IP or domain needed
 * - No firewall configuration
 * - Authentication only at connection time
 * - Plaintext messages after connection (no decryption needed)
 */

import type { ResolvedFeishuAccount, FeishuMessageReceiveEvent } from "./types.js";

/** WebSocket connection state */
export type WSConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** Event handler for incoming messages */
export type MessageHandler = (event: FeishuMessageReceiveEvent) => Promise<void>;

/** WebSocket client interface */
export interface FeishuWSClient {
  state: WSConnectionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onStateChange(handler: (state: WSConnectionState) => void): void;
}

/** WebSocket client options */
export interface WSClientOptions {
  account: ResolvedFeishuAccount;
  onMessage?: MessageHandler;
  onStateChange?: (state: WSConnectionState) => void;
  onError?: (error: Error) => void;
}

/**
 * Create a WebSocket client using the official Lark SDK
 *
 * Note: This requires @larksuiteoapi/node-sdk to be installed.
 * The SDK handles:
 * - Connection establishment and authentication
 * - Automatic reconnection
 * - Heartbeat/keepalive
 * - Message parsing
 */
export async function createWSClient(options: WSClientOptions): Promise<FeishuWSClient> {
  const { account, onMessage, onStateChange, onError } = options;

  let state: WSConnectionState = "disconnected";
  let messageHandler: MessageHandler | undefined = onMessage;
  let stateHandler: ((state: WSConnectionState) => void) | undefined = onStateChange;
  let wsClient: unknown = null;
  let larkSdk: typeof import("@larksuiteoapi/node-sdk") | null = null;

  const setState = (newState: WSConnectionState) => {
    state = newState;
    stateHandler?.(newState);
  };

  // Try to import the official SDK
  try {
    larkSdk = await import("@larksuiteoapi/node-sdk");
  } catch {
    throw new Error(
      "WebSocket mode requires @larksuiteoapi/node-sdk. " +
      "Install it with: npm install @larksuiteoapi/node-sdk"
    );
  }

  const client: FeishuWSClient = {
    get state() {
      return state;
    },

    async start() {
      if (!larkSdk) {
        throw new Error("Lark SDK not available");
      }

      if (!account.appId || !account.appSecret) {
        throw new Error("appId and appSecret are required for WebSocket connection");
      }

      setState("connecting");

      try {
        const baseConfig = {
          appId: account.appId,
          appSecret: account.appSecret,
          domain: account.domain === "lark" ? larkSdk.Domain.Lark : larkSdk.Domain.Feishu,
        };

        // Create WebSocket client
        wsClient = new larkSdk.WSClient({
          ...baseConfig,
          loggerLevel: larkSdk.LoggerLevel.info,
        });

        // Create event dispatcher
        const eventDispatcher = new larkSdk.EventDispatcher({}).register({
          "im.message.receive_v1": async (data: unknown) => {
            if (messageHandler) {
              try {
                // Convert SDK event format to our format
                const event = convertSdkEvent(data);
                await messageHandler(event);
              } catch (err) {
                onError?.(err instanceof Error ? err : new Error(String(err)));
              }
            }
          },
        });

        // Start the WebSocket client
        await (wsClient as { start: (opts: { eventDispatcher: unknown }) => Promise<void> }).start({
          eventDispatcher,
        });

        setState("connected");
      } catch (err) {
        setState("disconnected");
        throw err;
      }
    },

    async stop() {
      if (wsClient && typeof (wsClient as { close?: () => void }).close === "function") {
        (wsClient as { close: () => void }).close();
      }
      wsClient = null;
      setState("disconnected");
    },

    onMessage(handler: MessageHandler) {
      messageHandler = handler;
    },

    onStateChange(handler: (state: WSConnectionState) => void) {
      stateHandler = handler;
    },
  };

  return client;
}

/**
 * Convert SDK event format to our internal format
 */
function convertSdkEvent(data: unknown): FeishuMessageReceiveEvent {
  const event = data as {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
      root_id?: string;
      parent_id?: string;
    };
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
  };

  return {
    schema: "2.0",
    header: {
      event_id: "",
      event_type: "im.message.receive_v1",
      create_time: String(Date.now()),
      token: "",
      app_id: "",
      tenant_key: "",
    },
    event: {
      message: {
        message_id: event.message?.message_id || "",
        chat_id: event.message?.chat_id || "",
        chat_type: event.message?.chat_type || "p2p",
        message_type: event.message?.message_type || "text",
        content: event.message?.content || "",
        mentions: event.message?.mentions,
        root_id: event.message?.root_id,
        parent_id: event.message?.parent_id,
      },
      sender: {
        sender_id: event.sender?.sender_id || {},
        sender_type: event.sender?.sender_type || "user",
      },
    },
  };
}

/**
 * Simple native WebSocket implementation (fallback when SDK is not available)
 *
 * This is a basic implementation that connects to Feishu's WebSocket endpoint.
 * For production use, the official SDK is recommended.
 */
export async function createNativeWSClient(options: WSClientOptions): Promise<FeishuWSClient> {
  const { account, onMessage, onStateChange, onError } = options;

  let state: WSConnectionState = "disconnected";
  let messageHandler: MessageHandler | undefined = onMessage;
  let stateHandler: ((state: WSConnectionState) => void) | undefined = onStateChange;
  let ws: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000;

  const setState = (newState: WSConnectionState) => {
    state = newState;
    stateHandler?.(newState);
  };

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
  };

  const connect = async (): Promise<void> => {
    if (!account.appId || !account.appSecret) {
      throw new Error("appId and appSecret are required");
    }

    setState("connecting");

    // Get ticket for WebSocket connection
    const ticketUrl = `${account.apiBase}/callback/ws/endpoint`;
    const tokenResponse = await fetch(`${account.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
    });

    const tokenData = await tokenResponse.json() as { tenant_access_token?: string };
    if (!tokenData.tenant_access_token) {
      throw new Error("Failed to get access token");
    }

    const ticketResponse = await fetch(ticketUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokenData.tenant_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const ticketData = await ticketResponse.json() as {
      code?: number;
      data?: { url?: string };
    };

    if (ticketData.code !== 0 || !ticketData.data?.url) {
      throw new Error(`Failed to get WebSocket URL: ${JSON.stringify(ticketData)}`);
    }

    const wsUrl = ticketData.data.url;

    return new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setState("connected");
          reconnectAttempts = 0;

          // Start heartbeat
          heartbeatInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 30000);

          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string) as {
              type?: string;
              header?: { event_type?: string };
              event?: unknown;
            };

            // Handle pong
            if (data.type === "pong") {
              return;
            }

            // Handle message event
            if (data.header?.event_type === "im.message.receive_v1" && messageHandler) {
              const feishuEvent = data as unknown as FeishuMessageReceiveEvent;
              messageHandler(feishuEvent).catch((err) => {
                onError?.(err instanceof Error ? err : new Error(String(err)));
              });
            }
          } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        };

        ws.onerror = (event) => {
          onError?.(new Error(`WebSocket error: ${event}`));
        };

        ws.onclose = () => {
          cleanup();
          setState("disconnected");

          // Attempt reconnection
          if (reconnectAttempts < maxReconnectAttempts) {
            setState("reconnecting");
            const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts);
            reconnectAttempts++;

            reconnectTimeout = setTimeout(() => {
              connect().catch((err) => {
                onError?.(err instanceof Error ? err : new Error(String(err)));
              });
            }, delay);
          }
        };
      } catch (err) {
        setState("disconnected");
        reject(err);
      }
    });
  };

  const client: FeishuWSClient = {
    get state() {
      return state;
    },

    async start() {
      await connect();
    },

    async stop() {
      reconnectAttempts = maxReconnectAttempts; // Prevent reconnection
      cleanup();
      setState("disconnected");
    },

    onMessage(handler: MessageHandler) {
      messageHandler = handler;
    },

    onStateChange(handler: (state: WSConnectionState) => void) {
      stateHandler = handler;
    },
  };

  return client;
}
