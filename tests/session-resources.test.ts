import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const serverSource = fs.readFileSync(fileURLToPath(new URL("../server/index.ts", import.meta.url)), "utf8");
const factorySource = serverSource.slice(serverSource.indexOf("async function createWebUiSession"), serverSource.indexOf("function waitForChoiceResponse"));

test("session factory keeps default tools and request-choice", () => {
  assert.match(factorySource, /customTools,/);
  assert.doesNotMatch(factorySource, /\btools\s*:/);
  assert.doesNotMatch(factorySource, /setActiveToolsByName/);
  assert.match(factorySource, /assertSessionResources\(result\.session, resourceLoader\)/);
});

test("session activates default and custom tools and advertises skills", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-resources-"));
  try {
    const cwd = path.join(root, "home");
    const agentDir = path.join(root, "agent");
    const skillDir = path.join(agentDir, "skills", "fixture-skill");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill for session resource checks.\n---\n\n# Fixture\n");

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    const requestChoice = defineTool({
      name: "request-choice",
      label: "request-choice",
      description: "Return a fixture result.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      customTools: [requestChoice],
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    for (const name of ["read", "bash", "edit", "write", "request-choice"]) {
      assert.ok(session.getActiveToolNames().includes(name), `expected active tool: ${name}`);
    }
    assert.match(session.agent.state.systemPrompt, /<name>fixture-skill<\/name>/);
    session.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
