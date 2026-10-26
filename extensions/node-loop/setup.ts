/**
 * `exitnode setup`: pick a model for every node-loop role and set the task isolation settings.
 *
 * Flow: one picker per role (CONTRACT.md "Model roles" order), one isolation item, one summary confirm.
 * Nothing is written until the confirm; cancelling any dialog writes nothing.
 *
 * Writes go through the settings registry handles (`lookup(id)` from `config/registry`):
 * `modelRoles` is a record setting, so each role is written with `setEntry`, which touches only that
 * entry in the global `config.yml`; the isolation keys use `set`, which also targets the global layer.
 * When a handle or method is missing (older omp), or there is no UI, the exact config lines are
 * printed instead so the user can apply them by hand.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/** Roles in CONTRACT.md table order; `fallback` is the author's default, offered when it differs from the current value. */
export const ROLES = [
  { role: "node-plan", agent: "node-planner", fallback: "anthropic/claude-opus-5-5" },
  { role: "node-implement", agent: "node-implementer", fallback: "anthropic/claude-sonnet-5-5" },
  { role: "node-review", agent: "node-reviewer", fallback: "openai-codex/gpt-6.1-sol" },
  { role: "node-chair", agent: "council-chair", fallback: "anthropic/claude-opus-5-5" },
  { role: "council-seat-1", agent: "council-seat-1", fallback: "anthropic/claude-opus-5-5" },
  { role: "council-seat-2", agent: "council-seat-2", fallback: "openai-codex/gpt-6.1-sol" },
  { role: "council-seat-3", agent: "council-seat-3", fallback: "muse-code/muse-wonder-full-1.0" },
] as const;

/** Required isolation settings: each implementer works on its own `omp/task/<id>` branch, landed only after review. */
export const ISOLATION = [
  { id: "task.isolation.enabled", value: true },
  { id: "task.isolation.merge", value: "branch" },
  { id: "task.isolation.apply", value: false },
] as const;

type Scope = ExtensionAPI["pi"]["settings"];

/** The subset of a registry handle this file calls; methods are optional so an older omp degrades to the printed fallback. */
interface SettingHandle {
  get(scope: Scope): unknown;
  set?(scope: Scope, value: unknown): void;
  setEntry?(scope: Scope, key: string, value: unknown): void;
  provenance?(scope: Scope): string;
}

// Picker label suffixes; they are stripped back off through the label -> value map.
const CURRENT_MARK = "  (current)";
const FALLBACK_MARK = "  (author default)";
const CANCELLED = "exitnode setup cancelled; nothing written.";

function readRoles(value: unknown): Record<string, string> {
  const roles: Record<string, string> = {};
  if (!value || typeof value !== "object") return roles;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) roles[key] = entry;
  }
  return roles;
}

/** Exact lines for `~/.omp/agent/config.yml` and `omp config set`, used when writing is impossible. */
export function fallbackText(roles: Record<string, string>): string {
  const roleLines = ROLES.map(({ role, fallback }) => `  ${role}: ${roles[role] ?? fallback}`);
  const isoLines = ISOLATION.map(({ id, value }) => `omp config set ${id} ${String(value)}`);
  return [
    "Add these roles to ~/.omp/agent/config.yml (merge into an existing modelRoles block; `omp config path` prints the directory):",
    "",
    "modelRoles:",
    ...roleLines,
    "",
    "Then run:",
    "",
    ...isoLines,
  ].join("\n");
}

/** Shows text that must outlive a toast: in the transcript, in the notification, and in the log. */
function report(pi: ExtensionAPI, ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(text.split("\n")[0] ?? text, level);
  pi.sendMessage({ customType: "node-loop.setup", content: text, display: true }, { triggerTurn: false });
  pi.logger.info(`node-loop setup: ${text}`);
}

/** One role picker. Current value first (Enter keeps it), author default second, then every available model. */
async function pickRole(
  ctx: ExtensionContext,
  step: number,
  spec: (typeof ROLES)[number],
  current: string | undefined,
  models: string[],
): Promise<string | undefined> {
  const labels = new Map<string, string>();
  if (current) labels.set(current + CURRENT_MARK, current);
  if (spec.fallback !== current) labels.set(spec.fallback + FALLBACK_MARK, spec.fallback);
  for (const model of models) {
    if (model !== current && model !== spec.fallback) labels.set(model, model);
  }
  const title = `exitnode setup ${step}/${ROLES.length + 1}: model for ${spec.role} (agent ${spec.agent})`;
  const choice = await ctx.ui.select(title, [...labels.keys()]);
  return choice === undefined ? undefined : labels.get(choice);
}

export async function runSetup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const scope = pi.pi.settings;
  const rolesHandle: SettingHandle | undefined = lookup("modelRoles");
  const isolation = ISOLATION.map(spec => {
    const h: SettingHandle | undefined = lookup(spec.id);
    return { ...spec, handle: h, now: h?.get(scope) };
  });
  const current = readRoles(rolesHandle?.get(scope));

  if (!ctx.hasUI) {
    report(pi, ctx, `exitnode setup needs an interactive session.\n\n${fallbackText(current)}`, "warning");
    return;
  }

  const models = [...new Set(ctx.models.list().map(model => `${model.provider}/${model.id}`))].sort();
  const picks: Record<string, string> = {};
  for (const [index, spec] of ROLES.entries()) {
    const pick = await pickRole(ctx, index + 1, spec, current[spec.role], models);
    if (pick === undefined) {
      ctx.ui.notify(CANCELLED, "info");
      return;
    }
    picks[spec.role] = pick;
  }

  const isoDone = isolation.every(({ value, now }) => now === value);
  const isoLabel = `${isolation.map(({ id, value }) => `${id}=${String(value)}`).join(", ")}${isoDone ? "  (already set)" : ""}`;
  const isoChoice = await ctx.ui.select(`exitnode setup ${ROLES.length + 1}/${ROLES.length + 1}: task isolation (required)`, [isoLabel]);
  if (isoChoice === undefined) {
    ctx.ui.notify(CANCELLED, "info");
    return;
  }

  const summary = [
    "Global config (~/.omp/agent/config.yml) will get:",
    "",
    ...ROLES.map(({ role }) => `${role}: ${picks[role]}${picks[role] === current[role] ? "  (unchanged)" : ""}`),
    "",
    ...isolation.map(({ id, value, now }) => `${id}: ${String(value)}${now === value ? "  (unchanged)" : ""}`),
  ].join("\n");
  if (!(await ctx.ui.confirm("exitnode setup: write these settings?", summary))) {
    ctx.ui.notify(CANCELLED, "info");
    return;
  }

  const canWrite = typeof rolesHandle?.setEntry === "function" && isolation.every(({ handle: h }) => typeof h?.set === "function");
  if (!canWrite || !rolesHandle?.setEntry) {
    report(pi, ctx, `This omp version has no settings API for these keys.\n\n${fallbackText(picks)}`, "warning");
    return;
  }

  try {
    for (const { role } of ROLES) {
      if (picks[role] !== current[role]) rolesHandle.setEntry(scope, role, picks[role]);
    }
    for (const { value, now, handle: h } of isolation) {
      if (now !== value) h?.set?.(scope, value);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    report(pi, ctx, `exitnode setup could not write settings: ${reason}\n\n${fallbackText(picks)}`, "error");
    return;
  }

  // A project, overlay, env or runtime layer can still shadow the global write; name the layer so the user can fix it.
  const effectiveRoles = readRoles(rolesHandle.get(scope));
  const shadowed = [
    ...ROLES.filter(({ role }) => effectiveRoles[role] !== picks[role]).map(({ role }) => `modelRoles.${role} (${rolesHandle.provenance?.(scope) ?? "another layer"})`),
    ...isolation
      .filter(({ value, handle: h }) => h?.get(scope) !== value)
      .map(({ id, handle: h }) => `${id} (${h?.provenance?.(scope) ?? "another layer"})`),
  ];
  if (shadowed.length > 0) {
    report(pi, ctx, `exitnode setup wrote the global config, but these keys are still overridden:\n${shadowed.join("\n")}`, "warning");
    return;
  }
  ctx.ui.notify("exitnode setup done: roles and isolation written to the global config. Next: exitnode <goal>", "info");
}
