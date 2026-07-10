import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeMarkdownLinks, isSafeMarkdownLink, ALLOWED_MARKDOWN_LINK_SCHEMES } from "../shared/markdown-security.js";

test("allows safe markdown link schemes", () => {
  const markdown = "[Website](https://example.com) and [Mail](mailto:person@example.com)";
  assert.equal(sanitizeMarkdownLinks(markdown), markdown);
});

test("blocks javascript and data links", () => {
  assert.equal(sanitizeMarkdownLinks("[x](javascript:alert(1))"), "[x](#)");
  assert.equal(sanitizeMarkdownLinks("[x](data:text/plain,hello)"), "[x](#)");
  assert.equal(sanitizeMarkdownLinks("[x](java&#x73;cript:alert(1))"), "[x](#)");
  assert.equal(sanitizeMarkdownLinks("[x](java\nscript:alert(1))"), "[x](#)");
});

test("allows relative links", () => {
  assert.equal(sanitizeMarkdownLinks("[x](docs/readme.md)"), "[x](docs/readme.md)");
  assert.equal(sanitizeMarkdownLinks("[x](../assets/logo.png)"), "[x](../assets/logo.png)");
});

test("keeps markdown autolink for safe destination and blocks unsafe", () => {
  const withSafe = sanitizeMarkdownLinks("<https://example.com>");
  assert.equal(withSafe, "<https://example.com>");

  const withUnsafe = sanitizeMarkdownLinks("<javascript:alert(1)>");
  assert.equal(withUnsafe, "`javascript:alert(1)`");
});

test("checks reference-link destinations with the same sink policy", () => {
  // Source rewriting intentionally leaves reference definitions intact; the
  // markdown-block DOM patch calls this policy on the rendered href.
  assert.equal(sanitizeMarkdownLinks("[x][bad]\n\n[bad]: javascript:alert(1)"), "[x][bad]\n\n[bad]: javascript:alert(1)");
  assert.equal(isSafeMarkdownLink("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownLink("java&#x73;cript:alert(1)"), false);
});

test("exposes allowlist", () => {
  assert.ok(ALLOWED_MARKDOWN_LINK_SCHEMES.includes("https"));
  assert.equal((ALLOWED_MARKDOWN_LINK_SCHEMES as readonly string[]).includes("javascript"), false);
});
