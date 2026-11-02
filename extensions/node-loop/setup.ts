/**
 * `exitnode setup`: pick a model for every node-loop role and set the task isolation settings.
 *
 * Flow: one picker per role (CONTRACT.md "Model roles" order), one isolation item, one summary confirm.
 * Each role picker has two steps because the catalog holds hundreds of models (all of OpenRouter):
 * first a provider (or "Keep <current>" / the author default, which skip step two), then a model id
 * within that provider. Nothing is written until the confirm; cancelling any dialog writes nothing.
 *
 * Choices come from `omp models --json`, the catalog `--model` and the agents' roles resolve against.
 * `ctx.models.list()` is not used: on a fresh omp cache it can list ids that never resolve at run time.
 *
 * Writes go through the settings registry handles (`lookup(id)` from `config/registry`, loaded lazily so a
 * missing module only disables writing and never the `exitnode` keyword):
 * `modelRoles` is a record setting, so each role is written with `setEntry`, which touches only that
 * entry in the global `config.yml`; the isolation keys use `set`, which also targets the global layer.
 * When a handle or method is missing (older omp), or there is no UI, the exact config lines are
 * printed instead so the user can apply them by hand.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Roles in CONTRACT.md table order; `fallback` is the author's own pick, offered only when omp lists it for this user. */
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

type RegistryLookup = (id: string) => SettingHandle | undefined;

type CatalogModel = { provider: string; id: string };

// Picker label suffixes and prefixes; they are stripped back off through the label -> value map.
const CURRENT_MARK = "  (current)";
const KEEP_PREFIX = "Keep ";
const FALLBACK_PREFIX = "Author default ";
const CANCELLED = "exitnode setup cancelled; nothing written.";
// Thinking level after a role value (`anthropic/claude-opus-5-5:high`); it is not part of the model id.
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;
// Dated snapshot ids (`claude-sonnet-4-20250514`) duplicate their undated alias; hide them to cut noise.
const DATE_STAMP = /-\d{8}$/;
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Loads the settings registry at call time. The module is omp-internal, so it is imported dynamically on purpose:
 * a static import that fails would stop the whole extension, keyword hook included. A failure returns undefined,
 * and setup then prints the config lines instead.
 */
async function loadRegistry(): Promise<RegistryLookup | undefined> {
  try {
    const registry = (await import("@oh-my-pi/pi-coding-agent/config/registry")) as { lookup?: unknown };
    return typeof registry.lookup === "function" ? (registry.lookup as RegistryLookup) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits `provider/id` at the first slash; OpenRouter ids keep their inner slash (`openrouter/anthropic/claude-...`). */
function splitModel(value: string): { provider: string; id: string } {
  const slash = value.indexOf("/");
  return slash < 0 ? { provider: value, id: "" } : { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** The models `omp models --json` lists for this user, or undefined when that command cannot be read. */
async function readCatalog(pi: ExtensionAPI): Promise<CatalogModel[] | undefined> {
  try {
    const result = await pi.exec("omp", ["models", "--json"]);
    if (result.code !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as { models?: CatalogModel[] };
    return parsed.models;
  } catch {
    return undefined;
  }
}

/** Provider -> model ids, undated ids only (a provider with nothing but dated ids keeps them), newest-looking first. */
export function groupModels(models: readonly { provider: string; id: string }[]): Map<string, string[]> {
  const all = new Map<string, Set<string>>();
  for (const { provider, id } of models) {
    let ids = all.get(provider);
    if (!ids) all.set(provider, (ids = new Set()));
    ids.add(id);
  }
  const grouped = new Map<string, string[]>();
  for (const provider of [...all.keys()].sort(NATURAL.compare)) {
    const ids = [...all.get(provider)!];
    const undated = ids.filter(id => !DATE_STAMP.test(id));
    grouped.set(provider, (undated.length > 0 ? undated : ids).sort((a, b) => NATURAL.compare(b, a)));
  }
  return grouped;
}

function readRoles(value: unknown): Record<string, string> {
  const roles: Record<string, string> = {};
  if (!value || typeof value !== "object") return roles;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) roles[key] = entry;
  }
  return roles;
}

/**
 * Warnings for picks that still run but weaken review or the council. They are shown in the confirm and never block.
 * Same-provider review is a real option for a one-provider user, so the warning names the fix instead of refusing.
 */
function setupWarnings(picks: Record<string, string>): string[] {
  const warnings: string[] = [];
  const implementer = splitModel(picks["node-implement"] ?? "").provider;
  const reviewer = splitModel(picks["node-review"] ?? "").provider;
  if (implementer && implementer === reviewer) {
    warnings.push(
      `node-review and node-implement both use ${reviewer}, so review is same-provider. Add a second provider for cross-provider review.`,
    );
  }
  const seatsByModel = new Map<string, string[]>();
  for (const role of ["council-seat-1", "council-seat-2", "council-seat-3"]) {
    const model = picks[role];
    if (model) seatsByModel.set(model, [...(seatsByModel.get(model) ?? []), role]);
  }
  for (const [model, seats] of seatsByModel) {
    if (seats.length > 1) warnings.push(`${seats.join(" and ")} all use ${model}, so they share blind spots.`);
  }
  return warnings;
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

/**
 * One role picker in two steps. Step one: "Keep <current>" (skips step two), the author default when it differs
 * (also skips step two), then every provider with the current one first. Step two: that provider's model ids,
 * the current model first. Returns undefined when either dialog is cancelled.
 */
async function pickRole(
  ctx: ExtensionContext,
  step: number,
  spec: (typeof ROLES)[number],
  current: string | undefined,
  providers: Map<string, string[]>,
  available: Set<string>,
): Promise<string | undefined> {
  const title = `exitnode setup ${step}/${ROLES.length + 1}: model for ${spec.role} (agent ${spec.agent})`;
  const cur = current ? splitModel(current) : undefined;

  const first = new Map<string, { value: string } | { provider: string }>();
  if (current && available.has(current.replace(THINKING_SUFFIX, ""))) first.set(KEEP_PREFIX + current, { value: current });
  if (spec.fallback !== current && available.has(spec.fallback)) {
    first.set(FALLBACK_PREFIX + spec.fallback, { value: spec.fallback });
  }
  if (cur && providers.has(cur.provider)) first.set(cur.provider + CURRENT_MARK, { provider: cur.provider });
  for (const provider of providers.keys()) {
    if (provider !== cur?.provider) first.set(provider, { provider });
  }
  const firstChoice = await ctx.ui.select(`${title}: provider`, [...first.keys()]);
  const picked = firstChoice === undefined ? undefined : first.get(firstChoice);
  if (!picked) return undefined;
  if ("value" in picked) return picked.value;

  const second = new Map<string, string>();
  if (cur?.provider === picked.provider && cur.id) second.set(cur.id + CURRENT_MARK, current!);
  for (const id of providers.get(picked.provider) ?? []) {
    if (!(cur?.provider === picked.provider && id === cur.id)) second.set(id, `${picked.provider}/${id}`);
  }
  const choice = await ctx.ui.select(`${title}: ${picked.provider} model`, [...second.keys()]);
  return choice === undefined ? undefined : second.get(choice);
}

export async function runSetup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const scope = pi.pi.settings;
  const lookup = await loadRegistry();
  const rolesHandle: SettingHandle | undefined = lookup?.("modelRoles");
  const isolation = ISOLATION.map(spec => {
    const h: SettingHandle | undefined = lookup?.(spec.id);
    return { ...spec, handle: h, now: h?.get(scope) };
  });
  const current = readRoles(rolesHandle?.get(scope));

  if (!ctx.hasUI) {
    report(pi, ctx, `exitnode setup needs an interactive session.\n\n${fallbackText(current)}`, "warning");
    return;
  }

  const catalog = await readCatalog(pi);
  if (!catalog) {
    report(pi, ctx, "exitnode setup could not read `omp models --json`, so it cannot tell which models you can use. Run `omp models` to check, then run exitnode setup again.", "error");
    return;
  }
  if (catalog.length === 0) {
    report(pi, ctx, "exitnode setup found no models you can use. Sign in to at least one provider in omp, then run exitnode setup again.", "warning");
    return;
  }
  const available = new Set(catalog.map(({ provider, id }) => `${provider}/${id}`));
  const providers = groupModels(catalog);

  const picks: Record<string, string> = {};
  for (const [index, spec] of ROLES.entries()) {
    const pick = await pickRole(ctx, index + 1, spec, current[spec.role], providers, available);
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

  const warnings = setupWarnings(picks);
  const summary = [
    ...warnings.map(warning => `Warning: ${warning}`),
    ...(warnings.length > 0 ? [""] : []),
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
