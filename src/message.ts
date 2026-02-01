/**
 * Feishu message format conversion utilities
 */

import type {
  FeishuPostContent,
  FeishuPostElement,
  FeishuInteractiveContent,
  FeishuCardElement,
} from "./types.js";

/**
 * Convert plain text to Feishu text content
 */
export function textToFeishuContent(text: string): { text: string } {
  return { text };
}

/**
 * Convert markdown text to Feishu post (rich text) content
 */
export function markdownToFeishuPost(markdown: string, title?: string): FeishuPostContent {
  const lines = markdown.split("\n");
  const content: FeishuPostElement[][] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const elements: FeishuPostElement[] = [];
    let remaining = trimmedLine;

    // Parse inline elements
    while (remaining.length > 0) {
      // Check for links: [text](url)
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        elements.push({
          tag: "a",
          text: linkMatch[1],
          href: linkMatch[2],
        });
        remaining = remaining.slice(linkMatch[0].length);
        continue;
      }

      // Check for bold: **text** or __text__
      const boldMatch = remaining.match(/^\*\*([^*]+)\*\*|^__([^_]+)__/);
      if (boldMatch) {
        elements.push({
          tag: "text",
          text: boldMatch[1] || boldMatch[2],
        });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }

      // Check for inline code: `code`
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        elements.push({
          tag: "text",
          text: codeMatch[1],
        });
        remaining = remaining.slice(codeMatch[0].length);
        continue;
      }

      // Find next special character or end of string
      const nextSpecial = remaining.search(/\[|\*\*|__|`/);
      if (nextSpecial === -1) {
        // No more special characters, add remaining as text
        elements.push({
          tag: "text",
          text: remaining,
        });
        break;
      } else if (nextSpecial > 0) {
        // Add text before special character
        elements.push({
          tag: "text",
          text: remaining.slice(0, nextSpecial),
        });
        remaining = remaining.slice(nextSpecial);
      } else {
        // Special character not matched, treat as text
        elements.push({
          tag: "text",
          text: remaining[0],
        });
        remaining = remaining.slice(1);
      }
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

/**
 * Create a simple card with title and content
 */
export function createSimpleCard(
  title: string,
  content: string,
  color: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" = "blue",
): FeishuInteractiveContent {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: color,
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
}

/**
 * Create a card with multiple sections
 */
export function createSectionCard(
  title: string,
  sections: Array<{ title?: string; content: string }>,
  color: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" = "blue",
): FeishuInteractiveContent {
  const elements: FeishuCardElement[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];

    if (section.title) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${section.title}**`,
        },
      });
    }

    elements.push({
      tag: "markdown",
      content: section.content,
    });

    // Add divider between sections
    if (i < sections.length - 1) {
      elements.push({ tag: "hr" });
    }
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: color,
    },
    elements,
  };
}

/**
 * Create a card with action buttons
 */
export function createActionCard(
  title: string,
  content: string,
  actions: Array<{ text: string; url?: string; value?: unknown; type?: "primary" | "default" | "danger" }>,
  color: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" = "blue",
): FeishuInteractiveContent {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      template: color,
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
      {
        tag: "action",
        actions: actions.map((action) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: action.text,
          },
          url: action.url,
          type: action.type ?? "default",
          value: action.value,
        })),
      },
    ],
  };
}

/**
 * Convert Feishu message content to plain text
 */
export function feishuContentToText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content);

    switch (msgType) {
      case "text":
        return parsed.text ?? "";

      case "post":
        return extractTextFromPost(parsed);

      case "interactive":
        return extractTextFromCard(parsed);

      default:
        return content;
    }
  } catch {
    return content;
  }
}

/**
 * Extract plain text from post content
 */
function extractTextFromPost(post: FeishuPostContent): string {
  const texts: string[] = [];
  const postBody = post.zh_cn ?? post.en_us;

  if (postBody?.title) {
    texts.push(postBody.title);
  }

  if (postBody?.content) {
    for (const line of postBody.content) {
      const lineTexts: string[] = [];
      for (const element of line) {
        if (element.tag === "text") {
          lineTexts.push(element.text);
        } else if (element.tag === "a") {
          lineTexts.push(element.text);
        }
      }
      if (lineTexts.length > 0) {
        texts.push(lineTexts.join(""));
      }
    }
  }

  return texts.join("\n");
}

/**
 * Extract plain text from card content
 */
function extractTextFromCard(card: FeishuInteractiveContent): string {
  const texts: string[] = [];

  if (card.header?.title?.content) {
    texts.push(card.header.title.content);
  }

  if (card.elements) {
    for (const element of card.elements) {
      if (element.tag === "markdown" && "content" in element) {
        texts.push(element.content);
      } else if (element.tag === "div" && "text" in element && element.text?.content) {
        texts.push(element.text.content);
      }
    }
  }

  return texts.join("\n");
}

/**
 * Escape special characters for Feishu markdown
 */
export function escapeFeishuMarkdown(text: string): string {
  // Feishu markdown uses similar escaping to standard markdown
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/`/g, "\\`");
}

/**
 * Format mentions for Feishu
 */
export function formatMention(userId: string, userName?: string): string {
  // Feishu uses <at user_id="xxx">name</at> format in post messages
  // For card messages, use @user_id format
  return `<at user_id="${userId}">${userName ?? userId}</at>`;
}

/**
 * Create a text content with @ mention
 * Use open_id for the user to mention
 */
export function createTextWithMention(text: string, mentions: Array<{ openId: string; name: string }>): string {
  // For text messages, use <at user_id="open_id">name</at> format
  let result = text;
  for (const mention of mentions) {
    // Replace @name with the proper mention format
    result = result.replace(
      new RegExp(`@${mention.name}`, "g"),
      `<at user_id="${mention.openId}">${mention.name}</at>`
    );
  }
  return result;
}

/**
 * Replace mention placeholders in text with actual names
 * @param text - Text with placeholders like @_user_1
 * @param mentions - Array of mentions with key and name
 * @returns Text with placeholders replaced by @name
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
    result = result.replace(new RegExp(mention.key, "g"), `@${mention.name}`);
  }
  return result;
}

/**
 * Strip all mentions from text (for processing)
 */
export function stripMentions(
  text: string,
  mentions: Array<{ key: string }> | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) {
    return text;
  }

  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(mention.key, "g"), "");
  }
  return result.replace(/\s+/g, " ").trim();
}
