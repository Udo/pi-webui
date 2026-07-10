import { isSafeMarkdownLink } from "../shared/markdown-security.js";

function sanitizeMarkdownElement(root: ParentNode) {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") || "";
    if (isSafeMarkdownLink(href)) continue;
    anchor.removeAttribute("href");
    anchor.setAttribute("aria-disabled", "true");
    anchor.setAttribute("title", "Unsafe link blocked");
  }
  for (const image of root.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") || "";
    if (isSafeMarkdownLink(src) && !src.trim().toLowerCase().startsWith("mailto:") && !src.trim().toLowerCase().startsWith("tel:")) continue;
    image.removeAttribute("src");
    image.setAttribute("title", "Unsafe image source blocked");
  }
}

/**
 * mini-lit renders Marked output through unsafeHTML. Sanitize the resulting DOM
 * after every markdown-block update so inline links, reference links, autolinks,
 * images, thinking blocks, and artifact previews all use one URL policy.
 */
export function installMarkdownSecurityPatch() {
  const MarkdownBlock = customElements.get("markdown-block") as any;
  if (!MarkdownBlock || MarkdownBlock.prototype.__piWebuiLinkSecurityPatch) return;
  MarkdownBlock.prototype.__piWebuiLinkSecurityPatch = true;
  const originalUpdated = MarkdownBlock.prototype.updated;
  MarkdownBlock.prototype.updated = function (...args: any[]) {
    if (typeof originalUpdated === "function") originalUpdated.apply(this, args);
    sanitizeMarkdownElement(this);
  };
}
