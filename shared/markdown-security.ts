export const ALLOWED_MARKDOWN_LINK_SCHEMES = Object.freeze(["http", "https", "mailto", "tel"] as const);
export type AllowedMarkdownLinkScheme = (typeof ALLOWED_MARKDOWN_LINK_SCHEMES)[number];

function decodeEntityCodePoint(raw: string, value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : raw;
}

function decodeUrlCharacterEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (raw, hex) => decodeEntityCodePoint(raw, hex, 16))
    .replace(/&#([0-9]+);?/g, (raw, decimal) => decodeEntityCodePoint(raw, decimal, 10))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");
}

function isAllowedUrlScheme(rawDestination: string): boolean {
  const trimmed = rawDestination.trim();
  if (!trimmed) return false;

  // HTML attributes decode character references, and URL parsers ignore ASCII
  // whitespace/control characters in schemes. Normalize before allowlisting.
  const schemeProbe = decodeUrlCharacterEntities(trimmed).replace(/[\u0000-\u0020\u007f]/g, "");
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(schemeProbe);
  if (!schemeMatch) return true; // relative/hash/protocol-relative URL
  const scheme = schemeMatch[1].toLowerCase() as AllowedMarkdownLinkScheme;
  return ALLOWED_MARKDOWN_LINK_SCHEMES.includes(scheme);
}

function splitMarkdownDestination(raw: string): { destination: string; title: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { destination: "", title: "" };

  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close < 0) return { destination: trimmed, title: "" };
    const destination = trimmed.slice(1, close).trim();
    const title = trimmed.slice(close + 1).trim();
    return { destination, title };
  }

  const firstWhitespace = [...trimmed].findIndex((char) => char === " " || char === "\t" || char === "\n" || char === "\r");
  if (firstWhitespace < 0) {
    return { destination: trimmed, title: "" };
  }

  return { destination: trimmed.slice(0, firstWhitespace).trim(), title: trimmed.slice(firstWhitespace).trim() };
}

function sanitizeMarkdownLinkDestination(raw: string): string {
  const { destination } = splitMarkdownDestination(raw);
  // Check both the full raw destination (to catch whitespace-obfuscated schemes)
  // and the parsed destination (to preserve optional markdown link titles).
  if (!isAllowedUrlScheme(raw) || (destination && !isAllowedUrlScheme(destination))) {
    return "#";
  }
  return raw.trim();
}

function isMarkdownAutolinkCandidate(markdown: string): boolean {
  const trimmed = markdown.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.includes(":");
}

/**
 * Return markdown text where markdown link destinations use an explicit allowlist
 * of URL schemes. This protects against `javascript:`, `data:`, etc.
 */
export function sanitizeMarkdownLinks(markdown: string): string {
  if (!markdown.includes("[") && !markdown.includes("<")) return markdown;

  let sanitized = "";
  let index = 0;

  while (index < markdown.length) {
    const char = markdown[index];

    const autolinkEnd = markdown.indexOf(">", index + 1);
    if (char === "<" && autolinkEnd >= 0) {
      const candidate = markdown.slice(index + 1, autolinkEnd);
      const token = markdown.slice(index, autolinkEnd + 1);
      if (isMarkdownAutolinkCandidate(token)) {
        sanitized += isAllowedUrlScheme(candidate) ? token : `\`${candidate}\``;
        index = autolinkEnd + 1;
        continue;
      }
    }

    const linkTextStart = char === "[" || (char === "!" && markdown[index + 1] === "[");
    if (!linkTextStart) {
      sanitized += char;
      index += 1;
      continue;
    }

    const open = markdown[index] === "!" ? index + 1 : index;
    const labelEnd = markdown.indexOf("](", open);
    if (labelEnd < 0) {
      sanitized += char;
      index += 1;
      continue;
    }

    const destinationStart = labelEnd + 2;
    let destinationEnd = destinationStart;
    let depth = 0;
    while (destinationEnd < markdown.length) {
      const next = markdown[destinationEnd];
      if (next === "\\") {
        destinationEnd += 2;
        continue;
      }
      if (next === "(") {
        depth += 1;
      } else if (next === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      destinationEnd += 1;
    }

    if (destinationEnd >= markdown.length) {
      sanitized += markdown.slice(index);
      break;
    }

    const prefix = markdown.slice(index, destinationStart);
    const destination = markdown.slice(destinationStart, destinationEnd);
    sanitized += `${prefix}${sanitizeMarkdownLinkDestination(destination)})`;
    index = destinationEnd + 1;
  }

  return sanitized;
}

export function isSafeMarkdownLink(rawDestination: string): boolean {
  return isAllowedUrlScheme(rawDestination);
}
