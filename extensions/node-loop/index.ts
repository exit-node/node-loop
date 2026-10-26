/**
 * node-loop extension: the `exitnode` keyword, the `/exitnode` command, setup, and the forge view.
 *
 * Routing (CONTRACT.md "Extension"), shared by the keyword and the command:
 * - `exitnode setup` runs the role and isolation setup.
 * - `exitnode view` starts the forge server and opens it in the browser.
 * - `exitnode` or `exitnode <goal>` starts the node-loop skill.
 *
 * Non-obvious decisions:
 * - The keyword rewrites `exitnode setup` to `/exitnode setup` instead of running setup inside the
 *   `input` handler: dispatched handlers have a 30 s budget that cancels their UI, and setup is eight
 *   dialogs long. Command handlers have no such budget.
 * - `pi.sendUserMessage` skips slash and skill expansion, so the command expands the skill itself:
 *   it reads `skills/node-loop/SKILL.md`, strips the frontmatter and sends the body with the goal.
 * - `exitnode <rest>` keeps everything after the keyword, so `exitnode setup the auth module` is a goal;
 *   only an exact `setup` or `view` remainder selects a subcommand.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startForge } from "./forge/server.ts";
import { runSetup } from "./setup.ts";

// Lowercase, standalone first word; the remainder (possibly multi-line) is the goal or subcommand.
const KEYWORD = /^exitnode(?:\s+([\s\S]*))?$/;
const SKILL_FILE = fileURLToPath(new URL("../../skills/node-loop/SKILL.md", import.meta.url));
// Leading YAML frontmatter block, removed before the skill body is sent.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

type Route = { kind: "setup" } | { kind: "view" } | { kind: "goal"; goal: string };

/** Classifies what follows the keyword or the command name. */
function route(rest: string): Route {
  const goal = rest.trim();
  if (goal === "setup") return { kind: "setup" };
  if (goal === "view") return { kind: "view" };
  return { kind: "goal", goal };
}

/** Starts the forge (idempotent per CONTRACT.md) and opens it with the platform's URL opener. */
async function openForge(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  try {
    const { url } = await startForge();
    // `start` is a cmd.exe builtin; its first quoted argument is the window title, hence the empty string.
    const [command, args] =
      process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    try {
      await pi.exec(command, args);
    } catch {
      // No opener (headless Linux, sandbox): the notification below still carries the URL.
    }
    ctx.ui.notify(`Forge view: ${url}`, "info");
  } catch (error) {
    ctx.ui.notify(`Forge view failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** The `/skill:node-loop <goal>` prompt, built by hand because `sendUserMessage` does not expand skills. */
async function skillPrompt(goal: string): Promise<string> {
  const body = (await readFile(SKILL_FILE, "utf8")).replace(FRONTMATTER, "").trim();
  return [
    "The user invoked the node-loop skill through /exitnode.",
    "",
    body,
    "",
    `[Skill directory: ${dirname(SKILL_FILE)}] Resolve the skill's relative paths (scripts, templates) against this directory.`,
    ...(goal ? ["", `User: ${goal}`] : []),
  ].join("\n");
}

export default function nodeLoop(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const match = KEYWORD.exec(event.text.trim());
    if (!match) return;
    const target = route(match[1] ?? "");
    if (target.kind === "setup") return { text: "/exitnode setup" };
    if (target.kind === "view") {
      await openForge(pi, ctx);
      return { handled: true };
    }
    return { text: `/skill:node-loop ${target.goal}` };
  });

  pi.registerCommand("exitnode", {
    description: "node-loop: exitnode setup | view | <goal>",
    handler: async (args, ctx) => {
      const target = route(args);
      if (target.kind === "setup") return runSetup(pi, ctx);
      if (target.kind === "view") return openForge(pi, ctx);
      try {
        const prompt = await skillPrompt(target.goal);
        // While the agent is busy, a new loop belongs after the current run, not as a steer into it.
        pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`node-loop skill unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
