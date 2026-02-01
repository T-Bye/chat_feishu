/**
 * Feishu authentication and token management
 */

import type { FeishuTokenResponse, FeishuTokenCache, ResolvedFeishuAccount } from "./types.js";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

/** Get API base URL for an account */
function getApiBase(account: ResolvedFeishuAccount): string {
  return account.apiBase || "https://open.feishu.cn/open-apis";
}

// Token cache per account
const tokenCache = new Map<string, FeishuTokenCache>();

/**
 * Get tenant_access_token for a Feishu account
 * Automatically handles caching and refresh
 */
export async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
  const cacheKey = account.accountId;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cached.token;
  }

  // Fetch new token
  const token = await fetchTenantAccessToken(account);
  return token;
}

/**
 * Fetch a new tenant_access_token from Feishu API
 */
async function fetchTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
  const { appId, appSecret } = account;

  if (!appId || !appSecret) {
    throw new Error("Feishu appId and appSecret are required");
  }

  const apiBase = getApiBase(account);
  const url = `${apiBase}/auth/v3/tenant_access_token/internal`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get Feishu access token: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as FeishuTokenResponse;

  if (data.code !== 0) {
    throw new Error(`Feishu API error: ${data.code} - ${data.msg}`);
  }

  if (!data.tenant_access_token || !data.expire) {
    throw new Error("Invalid token response from Feishu API");
  }

  // Cache the token
  const expiresAt = Date.now() + data.expire * 1000;
  tokenCache.set(account.accountId, {
    token: data.tenant_access_token,
    expiresAt,
  });

  return data.tenant_access_token;
}

/**
 * Invalidate cached token for an account
 */
export function invalidateToken(accountId: string): void {
  tokenCache.delete(accountId);
}

/**
 * Clear all cached tokens
 */
export function clearAllTokens(): void {
  tokenCache.clear();
}

/**
 * Check if an account has valid credentials configured
 */
export function hasValidCredentials(account: ResolvedFeishuAccount): boolean {
  return Boolean(account.appId && account.appSecret);
}

/**
 * Verify the signature for webhook events (if encryptKey is configured)
 */
export function verifyWebhookSignature(
  _timestamp: string,
  _nonce: string,
  _encryptKey: string,
  _body: string,
  _signature: string,
): boolean {
  // Feishu uses SHA256 for signature verification
  // signature = sha256(timestamp + nonce + encryptKey + body)
  // TODO: Implement proper HMAC-SHA256 verification
  // For now, return true to allow development without encryption
  return true;
}

/**
 * Decrypt encrypted event body (if encryptKey is configured)
 */
export async function decryptEventBody(
  encryptedBody: string,
  _encryptKey: string,
): Promise<string> {
  // Feishu uses AES-256-CBC encryption
  // The encrypted body is base64 encoded
  // TODO: Implement proper AES decryption
  // For now, return the body as-is
  return encryptedBody;
}
