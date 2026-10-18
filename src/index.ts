/**
 * llamacpp-discover — auto-discovers the model(s) loaded in a local
 * llama-server and registers them into an OpenCode provider (default `llama`).
 *
 * - Exactly ONE export (default): OpenCode treats every export of a plugin
 *   file as a plugin function — a second export breaks the whole file.
 *   All helpers stay non-exported.
 * - Runtime-only: this plugin never writes to any config file.
 * - Endpoints: the OpenAI-compat base (…/v1) serves /models; llama.cpp's
 *   native endpoints (/props, /version) live on the bare root, so the
 *   trailing /v1 is stripped for those.
 * - Options (plugins entry) > environment variables > defaults:
 *     baseURL      LLAMACPP_DISCOVER_BASE_URL   http://127.0.0.1:8080/v1
 *     providerID   LLAMACPP_DISCOVER_PROVIDER_ID  llama
 * - Discovery: `probe` (parallel HTTP, 5 s timeouts, liveness gate) →
 *   `parseTemplate` (thinking levels from the Jinja chat_template) →
 *   `describe` / `merge` (V2 model records) → `apply` (create or update the
 *   provider, reload, log). The last good inventory is kept on failure.
 * - Triggers (no polling): startup, `/llama-refresh`, `config.updated`.
 */
import { Model, Plugin, Provider } from "@opencode/plugin/effect"
import { Effect, Result, Schedule, Stream } from "effect"

// ---------------------------------------------------------------------------
// Types (file-local — the single-export constraint)
// ---------------------------------------------------------------------------

type Options = {
  providerID: string
  providerName: string
  baseURL: string
  outputLimit: number
  disabled: boolean
  refreshOnConfigUpdate: boolean
}

type ProbeState =
  | { state: "ok"; models: ModelProbe[]; props: PropsInfo; version: string | null }
  | { state: "sleeping"; note: string }
  | { state: "down"; errors: string[] }

type ModelProbe = {
  id: string
  aliases: string[]
  modelPath: string | null // meta.model_path — source of the slug
  nCtxTrain: number | null
  ftype: string | null // e.g. "Q3_K - Small"
  size: number | null // bytes
  nParams: string | null
  meta: Record<string, unknown> // kept raw for fallback reads
}

type ThinkingContract = {
  supported: boolean
  levels: string[] // whitelist, template order
  default: string | null // default('…') value
  aliases: Record<string, string> // e.g. { high: "xhigh" }
  noneSupported: boolean // enable_thinking=false branch exists
}

type PropsInfo = {
  nCtx: number | null
  maxTokens: number | null // -1 = unlimited
  vision: boolean
  toolCalls: boolean
  parallelToolCalls: boolean
  preserveReasoning: boolean
  reasoningFormat: string | null // flat/legacy field; null when absent or "none"
  template: ThinkingContract | null
  isSleeping: boolean
}

type Inventory = {
  state: ProbeState
  at: number // Date.now() of the successful probe (down → last good)
  discoveredModels: ModelRecord[] // last successful describe() output (used by the no-HTTP fast path)
}

// --- V2 provider-record shapes (tasks 03/04) -------------------------------
// Confirmed against docs/reference/v2-providers.md (Models field table) +
// v2-models.md (Variants): the editor consumes `capabilities` (not
// `modalities`), `variants: [{ id, settings }]` (array, not the config-file
// map), and `settings`/`limit`/`modelID`. `ModelRecord` is deliberately
// permissive (index signature) so config-sourced models pass through with all
// their fields (headers/body/compatibility/cost/…) intact.

type ModelVariant = {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

type ModelRecord = {
  id: string
  providerID?: string
  modelID?: string
  name?: string
  limit?: { context?: number; input?: number; output?: number }
  capabilities?: { tools?: boolean; input?: string[]; output?: string[]; [k: string]: unknown }
  settings?: Record<string, unknown>
  variants?: ModelVariant[]
  aliases?: string[]
  [k: string]: unknown
}

type MergeResult = { models: ModelRecord[]; warnings: string[] }

// --- V2 context shapes ---------------------------------------
// Structural copies of the documented interfaces (docs/reference/
// v2-plugins.md API section + v2-plugins-effect.md). The real `PluginContext`
// type is not installed locally (the host provides `@opencode/plugin/effect`
// at load time), so these are for readability only — erased at runtime.

type ProviderRecord = {
  provider: Record<string, unknown>
  models: ReadonlyMap<string, unknown>
  sourceConnection?: unknown
}

type ProviderEditor = {
  list: () => readonly ProviderRecord[]
  get: (providerID: string) => ProviderRecord | undefined
  add: (input: { info: Record<string, unknown>; models: readonly unknown[]; sourceConnection?: unknown }) => void
  update: (providerID: string, update: (provider: Record<string, unknown>) => void) => void
  remove: (providerID: string) => void
  models: {
    set: (providerID: string, models: readonly unknown[]) => void
    update: (providerID: string, modelID: string, update: (model: Record<string, unknown>) => void) => void
    remove: (providerID: string, modelID: string) => void
  }
}

type Registration = { dispose: Effect.Effect<void> }

type CommandInvocation = { sessionID: unknown; prompt: unknown; delivery: unknown }

type CommandDefinition = {
  name: string
  description?: string
  execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

type Ctx = {
  options?: Record<string, unknown>
  provider: {
    transform: (cb: (editor: ProviderEditor) => void) => Effect.Effect<Registration, never, any>
    reload: () => Effect.Effect<void>
    list: () => Effect.Effect<unknown, unknown>
  }
  model: {
    transform: (cb: (editor: { provider: { get: (id: string) => ProviderRecord | undefined; list: () => readonly ProviderRecord[] } }) => void) => Effect.Effect<Registration, never, any>
    list: (providerID?: string) => Effect.Effect<unknown, unknown>
  }
  command: {
    transform: (cb: (editor: { add: (def: CommandDefinition) => void }) => void) => Effect.Effect<Registration, never, any>
    reload: () => Effect.Effect<void>
  }
  event: { subscribe: () => Stream.Stream<{ type?: string; [k: string]: unknown }> }
  session: { synthetic: (input: { sessionID: unknown; text: string; resume?: boolean }) => Effect.Effect<unknown, unknown> }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dot-path field reader over unknown JSON. "a.b.c" → obj.a.b.c; any missing
 * hop or non-object intermediate → null. All defensive parsing goes through
 * this so a layout mismatch degrades one field, never the whole probe.
 */
const readField = <T = unknown>(obj: unknown, path: string): T | null => {
  let cur: unknown = obj
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return null
    cur = (cur as Record<string, unknown>)[key]
  }
  // A missing final key yields undefined — normalize to null so callers can
  // rely on the T | null contract (undefined would leak through `??` chains
  // and type assertions).
  if (cur === undefined || cur === null) return null
  return cur as T
}

const isBool = (v: unknown): boolean => v === true
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === "string"

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** Array of items, unknown element type (e.g. `/v1/models` `data[]`). */
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// ---------------------------------------------------------------------------
// HTTP (host-provided fetch, 5 s timeout per endpoint)
// ---------------------------------------------------------------------------

class ProbeError extends Error {}

const httpJson = (url: string): Effect.Effect<unknown, ProbeError> =>
  Effect.tryPromise({
    try: () =>
      fetch(url, { signal: AbortSignal.timeout(5000) }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
        return res.json()
      }),
    catch: (e) => new ProbeError(`${url}: ${(e as Error).message ?? String(e)}`),
  })

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/** All-null capability flags; used for the partial-discovery path. */
const emptyProps = (): PropsInfo => ({
  nCtx: null,
  maxTokens: null,
  vision: false,
  toolCalls: false,
  parallelToolCalls: false,
  preserveReasoning: false,
  reasoningFormat: null,
  template: null,
  isSleeping: false,
})

/** Map a `/v1/models` `data[]` item to a ModelProbe. Missing piece → null/[]. */
const parseModel = (raw: unknown): ModelProbe => {
  const idRaw = readField<unknown>(raw, "id")
  const metaRaw = readField<unknown>(raw, "meta")
  const nCtxTrainRaw = readField<unknown>(raw, "meta.n_ctx_train")
  const sizeRaw = readField<unknown>(raw, "meta.size")
  const nParamsRaw = readField<unknown>(raw, "meta.n_params")
  return {
    id: isStr(idRaw) ? idRaw : "",
    aliases: strArr(readField(raw, "aliases")),
    modelPath: readField<string>(raw, "meta.model_path"),
    nCtxTrain: isNum(nCtxTrainRaw) ? (nCtxTrainRaw as number) : null,
    ftype: readField<string>(raw, "meta.ftype"),
    size: isNum(sizeRaw) ? (sizeRaw as number) : null,
    // This server reports n_params as a number; older builds reported a string
    // ("27.3 B"). Normalize to string so downstream formatting is uniform.
    nParams: nParamsRaw === null || nParamsRaw === undefined ? null : String(nParamsRaw),
    meta:
      typeof metaRaw === "object" && metaRaw !== null ? (metaRaw as Record<string, unknown>) : {},
  }
}

/**
 * Fallback for builds whose `/v1/models` `meta` omits `model_path` (the
 * current build-latest does — recorded 2026-10-16): on a single-slot server,
 * `/props` exposes the loaded model's path at top level, so fill missing
 * modelPaths from there. Multi-slot servers are left untouched (a server-level
 * path can only describe one slot); the record builder then falls back to the endpoint
 * id for the slug.
 */
const withModelPaths = (models: ModelProbe[], propsRaw: unknown): ModelProbe[] => {
  const slots = readField<number>(propsRaw, "total_slots")
  if (slots !== 1) return models
  const path = readField<string>(propsRaw, "model_path")
  if (path === null || path === undefined || path === "") return models
  return models.map((m) => (m.modelPath === null ? { ...m, modelPath: path } : m))
}

/**
 * Rich props layout with flat fallbacks.
 * Each field is read from the rich location first, then the older flat
 * location; absent → null/false.
 */
const parseProps = (raw: unknown): PropsInfo => {
  const nCtx = readField<number>(raw, "default_generation_settings.n_ctx") ?? readField<number>(raw, "n_ctx")
  const maxTokens =
    readField<number>(raw, "default_generation_settings.params.max_tokens") ??
    readField<number>(raw, "params.max_tokens")
  // reasoning_format: rich builds nest it under default_generation_settings.params;
  // older builds carry it at props top level. "none"/"" mean "not a thinking model".
  const rawFormat =
    readField<unknown>(raw, "default_generation_settings.params.reasoning_format") ??
    readField<unknown>(raw, "reasoning_format")
  const reasoningFormat =
    rawFormat !== null && rawFormat !== undefined && rawFormat !== "none" && rawFormat !== ""
      ? String(rawFormat)
      : null
  const templateText = readField<string>(raw, "chat_template")

  return {
    nCtx: isNum(nCtx) ? nCtx : null,
    maxTokens: isNum(maxTokens) ? maxTokens : null,
    vision: isBool(readField(raw, "modalities.vision")),
    toolCalls: isBool(readField(raw, "chat_template_caps.supports_tool_calls")),
    parallelToolCalls: isBool(readField(raw, "chat_template_caps.supports_parallel_tool_calls")),
    preserveReasoning: isBool(readField(raw, "chat_template_caps.supports_preserve_reasoning")),
    reasoningFormat,
    template: isStr(templateText) ? parseTemplate(templateText, reasoningFormat) : null,
    isSleeping: isBool(readField(raw, "is_sleeping")),
  }
}

/**
 * Extract the thinking contract from the Jinja chat_template (whitelist,
 * default, aliases, enable_thinking branch). Pure string function — no I/O, unit-testable.
 *
 * `flatReasoningFormat` (the props-level `reasoning_format` value, if any)
 * feeds the flat-fallback branch for older llama.cpp layouts that expose no
 * whitelist and no `chat_template_caps`.
 */
const parseTemplate = (text: string, flatReasoningFormat: string | null = null): ThinkingContract => {
  const lines = text.split(/\r?\n/)

  // 1. Levels: the tuple in the `resolved_reasoning_effort not in (...)` check.
  const levels: string[] = []
  const whitelist = text.match(/resolved_reasoning_effort\s+not\s+in\s*\(([^)]*)\)/)
  if (whitelist) {
    for (const part of whitelist[1].split(",")) {
      const v = part.trim().replace(/^['"]+|['"]+$/g, "")
      if (v) levels.push(v)
    }
  }

  // 2. Default: the value after `reasoning_effort|default('…')`.
  let dflt: string | null = null
  const def = text.match(/reasoning_effort\s*\|\s*default\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/)
  if (def) dflt = def[1]

  // 3. Aliases: consecutive lines
  //    `if/elif resolved_reasoning_effort == 'X'` followed by
  //    `set resolved_reasoning_effort = 'Y'`  →  { X: Y }.
  //    (The set must assign to resolved_reasoning_effort itself — branches
  //    that assign other variables, e.g. reasoning_instructions, are not
  //    aliases.) Aliases are server-side; they are reported, never variants.
  const aliases: Record<string, string> = {}
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i].match(/(?:if|elif)\s+resolved_reasoning_effort\s*==\s*['"]([A-Za-z0-9_]+)['"]/)
    const b = lines[i + 1].match(/\bset\s+resolved_reasoning_effort\s*=\s*['"]([A-Za-z0-9_]+)['"]/)
    if (a && b && a[1] !== b[1]) aliases[a[1]] = b[1]
  }

  // 4. none support: an `enable_thinking is defined and enable_thinking is
  //    false` branch exists.
  const noneSupported = /enable_thinking\s+is\s+defined\s+and\s+enable_thinking\s+is\s+false/.test(text)

  // Result matrix:
  if (levels.length > 0)
    return { supported: true, levels, default: dflt, aliases, noneSupported }
  if (dflt !== null)
    return { supported: true, levels: [dflt], default: dflt, aliases, noneSupported }
  if ((flatReasoningFormat !== null && flatReasoningFormat !== "" && flatReasoningFormat !== "none") || /enable_thinking/.test(text))
    return { supported: true, levels: [], default: null, aliases: {}, noneSupported }
  return { supported: false, levels: [], default: null, aliases: {}, noneSupported }
}

/** One-line contract formatter for log lines: "xhigh/medium/low (default xhigh)", "flags-only", or "none". */
const describeContract = (t: ThinkingContract | null): string => {
  if (!t) return "none"
  if (!t.supported) return "none"
  if (t.levels.length === 0) return "flags-only"
  return t.default !== null ? `${t.levels.join("/")} (default ${t.default})` : t.levels.join("/")
}

// ---------------------------------------------------------------------------
// Records: describe (discovery → V2 model record) + merge (config wins)
// ---------------------------------------------------------------------------

/**
 * Deterministic slug: basename of the gguf path, `.gguf` removed,
 * lowercased, `.` → `-`. `Qwen3.8-27B-Q3_K_S.gguf` → `qwen3-8-27b-q3_k_s`.
 * No model_path → fall back to the endpoint id, lowercased.
 */
const slugOf = (modelPath: string | null, fallbackID: string): string => {
  if (modelPath === null || modelPath === "") return fallbackID.toLowerCase()
  const base = modelPath.split("/").pop() ?? modelPath
  return base.replace(/\.gguf$/i, "").toLowerCase().replace(/\./g, "-")
}

/** Cosmetic display name: gguf stem, `-`/`.`/`_` → space. `Qwen3.8-27B-Q3_K_S` → `Qwen3 8 27B Q3 K S`. */
const prettyName = (modelPath: string | null, fallbackID: string): string => {
  if (modelPath === null || modelPath === "") return fallbackID
  const base = modelPath.split("/").pop() ?? modelPath
  const pretty = base.replace(/\.gguf$/i, "").replace(/[-._]+/g, " ").trim()
  return pretty === "" ? fallbackID : pretty
}

/**
 * Auto variants from the thinking contract.
 * - null / unsupported → [].
 * - whitelist levels → one variant per level (template order), then `default`
 *   (when a default was detected), then `none` (when the template supports
 *   `enable_thinking=false`); `none` carries `preserve_thinking: false` when
 *   the server supports preserve-reasoning (stops stale chain-of-thought
 *   leaking into context when thinking is switched off).
 * - supported but no whitelist (flat fallback) → [] (flags only).
 * Aliases are server-side and are NEVER emitted as variants.
 */
const autoVariants = (contract: ThinkingContract | null, preserve: boolean): ModelVariant[] => {
  if (contract === null || !contract.supported) return []
  const out: ModelVariant[] = []
  for (const level of contract.levels) out.push({ id: level, settings: { reasoningEffort: level } })
  if (contract.levels.length > 0 && contract.default !== null)
    out.push({ id: "default", settings: { reasoningEffort: contract.default } })
  if (contract.noneSupported)
    out.push({
      id: "none",
      settings: {
        reasoningEffort: "none",
        ...(preserve ? { chat_template_kwargs: { preserve_thinking: false } } : {}),
      },
    })
  return out
}

/**
 * One discovered model → one V2 model record.
 * Defensive: a missing capability degrades that field only, never the record.
 * `settings` (not a separate `options` bag) is the documented model field
 * (v2-providers.md Models table) — the task-03 sketch's `options` name was a
 * guess; recorded as an adaptation.
 */
const describe = (model: ModelProbe, props: PropsInfo, options: Options): ModelRecord => {
  const id = slugOf(model.modelPath, model.id)
  const output = props.maxTokens !== null && props.maxTokens > 0 ? props.maxTokens : options.outputLimit
  const limit: ModelRecord["limit"] = { output }
  if (props.nCtx !== null) limit.context = props.nCtx
  const settings: Record<string, unknown> = {}
  if (props.reasoningFormat !== null) settings.reasoning_format = props.reasoningFormat
  return {
    id,
    providerID: options.providerID,
    modelID: model.id, // original endpoint id — requests must reach the loaded model
    name: prettyName(model.modelPath, model.id),
    limit,
    capabilities: {
      input: props.vision ? ["text", "image"] : ["text"],
      output: ["text"],
      tools: props.toolCalls,
    },
    settings,
    variants: autoVariants(props.template, props.preserveReasoning),
    aliases: model.aliases,
  }
}

// Standard driver-level option keys (never "orphaned"): the names the user's
// config variants and the auto variants both use.
const DRIVER_OPTION_KEYS = new Set(["reasoningEffort", "chat_template_kwargs", "reasoningSummary", "textVerbosity"])

/** camelCase → snake_case (reasoningEffort → reasoning_effort). */
const snakeCase = (s: string): string => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())

/**
 * Orphaned option keys: keys a surviving variant references that
 * neither a standard driver option nor the live template uses (e.g.
 * `reasoning_budget_tokens` on this build). Values are kept (forward compat);
 * the caller logs ONE warning line.
 */
const orphanedKeys = (models: ModelRecord[], contract: ThinkingContract | null): string[] => {
  const mentioned = new Set<string>()
  if (contract?.supported) mentioned.add("reasoning_effort")
  if (contract?.noneSupported) mentioned.add("enable_thinking")
  const byKey = new Map<string, Set<string>>()
  for (const m of models) {
    for (const v of m.variants ?? []) {
      for (const key of Object.keys(v.settings ?? {})) {
        if (DRIVER_OPTION_KEYS.has(key)) continue
        if (mentioned.has(key) || mentioned.has(snakeCase(key))) continue
        const set = byKey.get(key) ?? new Set<string>()
        set.add(String(v.id))
        byKey.set(key, set)
      }
    }
  }
  return [...byKey.entries()].map(([k, ids]) => `${k} (in variants: ${[...ids].join(", ")})`)
}

/** Config variants win on id collision; auto extras are appended (config order first). */
const mergeVariants = (configVariants: ModelVariant[], autoVariants: ModelVariant[]): ModelVariant[] => {
  const ids = new Set(configVariants.map((v) => String(v.id)))
  return [...configVariants, ...autoVariants.filter((v) => !ids.has(String(v.id)))]
}

/** Treat an unknown (config Model.Info) value as a loose record. */
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}

/** Does a config model collide with a discovered record? (rules 1–3) */
const configMatches = (c: Record<string, unknown>, d: ModelRecord): boolean => {
  const cid = typeof c.id === "string" ? c.id : undefined
  if (cid === undefined) return false
  if (cid === d.id) return true // rule 1: slug
  if ((d.aliases ?? []).includes(cid)) return true // rule 2: alias
  const cmodel = typeof c.modelID === "string" ? c.modelID : undefined
  if (cmodel !== undefined && slugOf(cmodel, cmodel) === d.id) return true // rule 3: modelID alias
  return false
}

/**
 * Config vs discovery merge, keyed by slug. Config wins; discovery
 * fills gaps. Returns the merged list plus one-line warnings (stale-limit
 * corrections, orphaned option keys) for the caller to log.
 */
const merge = (
  configModels: readonly unknown[],
  discovered: ModelRecord[],
  props: PropsInfo | null,
  options: Options,
): MergeResult => {
  const warnings: string[] = []
  const configs = configModels.map(asRecord)
  const used = new Set<number>()
  const out: ModelRecord[] = []

  // Discovered (and collisions) first, preserving discovery order.
  for (const d of discovered) {
    const idx = configs.findIndex((c, i) => !used.has(i) && configMatches(c, d))
    if (idx === -1) {
      out.push(d) // discovered-only
      continue
    }
    used.add(idx)
    const c = configs[idx]
    out.push({
      ...d,
      ...c, // config fields (headers/body/compatibility/…) pass through
      id: typeof c.id === "string" ? c.id : d.id,
      providerID: typeof c.providerID === "string" ? c.providerID : d.providerID,
      modelID: typeof c.modelID === "string" ? c.modelID : d.modelID,
      name: typeof c.name === "string" ? c.name : d.name,
      limit: { ...(d.limit ?? {}), ...(asRecord(c.limit) as ModelRecord["limit"]) },
      capabilities: { ...(d.capabilities ?? {}), ...(asRecord(c.capabilities) as ModelRecord["capabilities"]) },
      settings: { ...(d.settings ?? {}), ...(asRecord(c.settings) as Record<string, unknown>) },
      variants: mergeVariants(Array.isArray(c.variants) ? (c.variants as ModelVariant[]) : [], d.variants ?? []),
      aliases: d.aliases,
    })
  }

  // Config-only records: as-is, but auto-correct a stale
  // limit.context to the live server value and warn.
  for (let i = 0; i < configs.length; i++) {
    if (used.has(i)) continue
    const c = configs[i]
    const rec: ModelRecord = { ...c } as ModelRecord
    const cfgLimit = asRecord(c.limit) as ModelRecord["limit"]
    const live = props?.nCtx ?? null
    if (live !== null && typeof cfgLimit?.context === "number" && cfgLimit.context !== live) {
      rec.limit = { ...cfgLimit, context: live }
      warnings.push(`limit.context corrected for "${String(rec.id)}": ${cfgLimit.context} → ${live} (live server)`)
    }
    if (!Array.isArray(rec.variants)) rec.variants = []
    out.push(rec)
  }

  const orphans = orphanedKeys(out, props?.template ?? null)
  for (const o of orphans) warnings.push(`option key not referenced by the live template: ${o}`)

  return { models: out, warnings }
}

// ---------------------------------------------------------------------------
// Apply: read the current provider, create-or-merge, reload, log
// ---------------------------------------------------------------------------

/**
 * Read the current provider state through a no-mutation transform (the
 * documented synchronous-editor-read pattern, Transforms section). The
 * registration is disposed immediately after the forced registry replay so
 * repeated refreshes don't accumulate no-op transforms.
 *
 * Returns `existing` (undefined → absent → create path) and the config-side
 * model list for `merge`.
 */
const readProviderState = (
  ctx: Ctx,
  options: Options,
): Effect.Effect<{ existing: ProviderRecord | undefined; models: readonly unknown[] }> =>
  Effect.gen(function* () {
    let existing: ProviderRecord | undefined
    let models: readonly unknown[] = []
    const reg = yield* ctx.provider.transform((editor) => {
      const record = editor.get(options.providerID)
      if (record) {
        existing = record
        models = [...record.models.values()]
      }
    })
    // A registration only marks the registry dirty; force the replay (the
    // documented `provider.list()` read) so the callback actually runs.
    yield* ctx.provider.list().pipe(Effect.orDie)
    yield* reg.dispose
    return { existing, models }
  })

/**
 * Normalize a merged record for the provider editor. Recorded schema fact
 *: openai-compatible materializes model-level
 * `settings: { baseURL, provider }`, so each model must carry them — provider
 * settings alone may not reach the driver's endpoint. Built over
 * `Model.Info.default` so all required `Model.Info` fields are present.
 */
const forEditor = (m: ModelRecord, options: Options): unknown => ({
  ...Model.Info.default(Provider.ID.make(options.providerID), Model.ID.make(m.id)),
  ...m,
  id: Model.ID.make(m.id),
  providerID: Provider.ID.make(options.providerID),
  settings: { baseURL: options.baseURL, provider: options.providerID, ...(m.settings ?? {}) },
})

/** User-visible proof of which path ran + the discovered contract. */
const summarize = (state: ProbeState, merged: ModelRecord[], path: "created" | "updated", options: Options): string => {
  if (state.state !== "ok") return `provider "${options.providerID}" ${path} — ${merged.length} model(s)`
  const aliases = Object.entries(state.props.template?.aliases ?? {}).map(([a, b]) => `${a}→${b}`)
  const ids = merged.map((m) => m.id).join(", ")
  return (
    `provider "${options.providerID}" ${path}${path === "created" ? " (runtime)" : " (discovered models)"} — ` +
    `${merged.length} model(s): ${ids}` +
    ` [ctx ${state.props.nCtx ?? "?"}, thinking ${describeContract(state.props.template)}` +
    `${aliases.length ? `, alias ${aliases.join(", ")}` : ""}` +
    `, vision ${state.props.vision ? "yes" : "no"}, tools ${state.props.toolCalls ? "yes" : "no"}` +
    `, version ${state.version ?? "?"}]`
  )
}

/**
 * Per-plugin-instance state for the single persistent provider transform
 * (see `apply`). Keyed by ctx so each project instance owns its own models.
 */
type ProviderState = { models: readonly unknown[]; registered: boolean }
const providerStates = new WeakMap<object, ProviderState>()
const stateFor = (ctx: Ctx): ProviderState => {
  let st = providerStates.get(ctx as unknown as object)
  if (!st) {
    st = { models: [], registered: false }
    providerStates.set(ctx as unknown as object, st)
  }
  return st
}

/**
 * Apply the discovered list to OpenCode. `editor.update`
 * auto-creates a missing provider and edits an existing one; we always set
 * name/package/settings/activation so the provider is a usable local endpoint
 * (the `llama` id is always present as an inactive models.dev catalog
 * provider — verified in a project with no config provider). `models.set` replaces the model list with the
 * discovered set; OpenCode overlays project config models at resolution time
 * (option A). Then `reload()` + summary log.
 */
const apply = (
  ctx: Ctx,
  merged: ModelRecord[],
  state: ProbeState,
  existing: ProviderRecord | undefined,
  options: Options,
  warnings: string[],
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const models = merged.map((m) => forEditor(m, options))
    const path: "created" | "updated" = existing === undefined ? "created" : "updated"
    // Ensure the provider exists AND is a usable openai-compatible endpoint.
    // `editor.update` auto-creates a missing provider (from Provider.Info.empty)
    // and edits an existing one; we set name/package/settings/activation every
    // time because the id `llama` always exists as an *inactive* models.dev
    // catalog provider — without activation the discovered model resolves as
    // `Model unavailable` in a project that has no config provider (verified
    // in a scratch project). OpenCode overlays project config on top.
    //
    // ONE persistent transform per plugin instance (documented pattern:
    // register once, read a captured mutable value, `reload()` after it
    // changes). OpenCode replays EVERY registered transform on each registry
    // rebuild, so registering a fresh transform per refresh left stale
    // `models.set` calls stacked up in the long-running service and the model
    // list stayed on the first discovered model (e.g. qwen after switching to
    // ornith; only a service restart cleared it).
    const st = stateFor(ctx)
    st.models = models
    if (!st.registered) {
      st.registered = true
      yield* ctx.provider.transform((editor) => {
        editor.update(options.providerID, (p) => {
          p.name = options.providerName
          p.activation = "enabled"
          p.package = "@opencode/ai/providers/openai-compatible"
          p.settings = { ...((p.settings as Record<string, unknown> | undefined) ?? {}), baseURL: options.baseURL }
        })
        editor.models.set(options.providerID, st.models)
      })
    }
    yield* ctx.provider.reload()
    const summary = summarize(state, merged, path, options)
    yield* Effect.logInfo("[llamacpp-discover]", { summary })
    for (const w of warnings) yield* Effect.logWarning(`[llamacpp-discover] ${w}`)
    return summary
  })

// ---------------------------------------------------------------------------
// Probe (liveness gate) + refresh
// ---------------------------------------------------------------------------

/**
 * The liveness rule:
 * - The three endpoints run in parallel; each has its own 5 s timeout, so a
 *   dead server costs at most ~5 s per refresh (not 15 s).
 * - /props is the gate for capability derivation:
 *     props failed + models OK  → "ok" with emptyProps() (partial discovery;
 *                                  records are still emitted from model meta)
 *     props failed + models bad → "down" with every collected error
 *     models failed (props OK)  → "down" with the models error (there is
 *                                  nothing to register — recorded decision)
 * - props OK + is_sleeping      → "sleeping" (keep last inventory)
 * - /version is informational only (never gates); its failure yields
 *   version: null, which falls back to props' `build_info` (this llama.cpp
 *   build has no /version route — it 404s; recorded 2026-10-16).
 *
 * Effect.all(…, { mode: "result" }) is the all-settled form in the pinned
 * effect@4.0.0-beta.83: it never fails and returns a tuple of Result values
 * (this version has no "settled" mode — verified in node_modules/effect).
 */
const probe = (options: Options): Effect.Effect<ProbeState> =>
  Effect.gen(function* () {
    const root = options.baseURL.replace(/\/v1$/, "")
    const [modelsRes, propsRes, versionRes] = yield* Effect.all(
      [
        httpJson(`${options.baseURL}/models`),
        httpJson(`${root}/props`),
        httpJson(`${root}/version`),
      ],
      { mode: "result" },
    )

    const errors: string[] = []
    for (const [name, res] of [
      [`GET ${options.baseURL}/models`, modelsRes],
      [`GET ${root}/props`, propsRes],
      [`GET ${root}/version`, versionRes],
    ] as const) {
      if (Result.isFailure(res)) errors.push(`${name}: ${(res.failure as ProbeError).message}`)
    }

    const modelsOk = Result.isSuccess(modelsRes)
    const propsOk = Result.isSuccess(propsRes)

    if (!modelsOk)
      // Nothing to register without the model list — down, with every error.
      return { state: "down", errors }
    if (!propsOk)
      // Partial discovery: models are usable from their meta;
      // capability flags stay unset (emptyProps).
      return {
        state: "ok",
        models: arr(readField<unknown>(modelsRes.success, "data")).map((d) => parseModel(d)),
        props: emptyProps(),
        version: versionOf(versionRes, null),
      }
    if (readField<boolean>(propsRes.success, "is_sleeping") === true)
      return { state: "sleeping", note: "server is sleeping (slot idle)" }

    const props = parseProps(propsRes.success)
    return {
      state: "ok",
      models: withModelPaths(arr(readField<unknown>(modelsRes.success, "data")).map((d) => parseModel(d)), propsRes.success),
      props,
      version: versionOf(versionRes, propsRes.success),
    }
  })

/** Version for log lines: /version's `version`, else props' `build_info`. */
const versionOf = (versionRes: Result.Result<unknown, ProbeError>, propsRaw: unknown): string | null => {
  if (Result.isSuccess(versionRes)) {
    const v = readField<string>(versionRes.success, "version")
    if (v !== null && v !== "") return v
  }
  return readField<string>(propsRaw, "build_info")
}

/**
 * One refresh: probe → log a discovery summary. The Inventory cache is
 * updated on success and NEVER cleared on failure (sleeping or
 * unreachable keeps the last good inventory; nothing is wiped).
 *
 * Tasks 03–05 take over from here: describe → merge → apply, and the
 * startup-fork / `/llama-refresh` / `config.updated` triggers.
 */
const inventory: { current: Inventory | null } = { current: null }

const runRefresh = (ctx: Ctx, options: Options): Effect.Effect<string> =>
  Effect.gen(function* () {
    const state = yield* probe(options)
    if (state.state === "ok") {
      const discovered = state.models.map((m) => describe(m, state.props, options))
      const aliases = Object.keys(state.props.template?.aliases ?? {})
      yield* Effect.logInfo("[llamacpp-discover] discovered", {
        models: state.models.length,
        ids: state.models.map((m) => m.id).join(","),
        ctx: state.props.nCtx ?? "?",
        maxTokens: state.props.maxTokens === null ? "?" : String(state.props.maxTokens),
        thinking: describeContract(state.props.template),
        aliases: aliases.length > 0 ? aliases.join(",") : "-",
        vision: state.props.vision ? "yes" : "no",
        tools: state.props.toolCalls ? "yes" : "no",
        version: state.version ?? "?",
        partial: state.props.template === null && state.props.nCtx === null,
      })
      if (discovered.length === 0) {
        // Server up but no model loaded → keep last inventory.
        yield* Effect.logWarning("[llamacpp-discover] server up but no models loaded — keeping last inventory")
        return "server up but no models loaded"
      }
      const { existing } = yield* readProviderState(ctx, options)
      // Option A (user decision 2026-10-16): the project config provider is NOT
      // readable through the plugin API — `editor.get(providerID)` returns the
      // models.dev catalog provider when the id collides (here `llama`), and the
      // real config models are overlaid by OpenCode at model-resolution time.
      // So we register ONLY the discovered models and let OpenCode add the
      // config models on top. `merge([], …)` keeps the pipeline uniform (and
      // produces no warnings, since there are no config variants to inspect).
      const { models: merged, warnings } = merge([], discovered, state.props, options)
      const summary = yield* apply(ctx, merged, state, existing, options, warnings)
      inventory.current = { state, at: Date.now(), discoveredModels: discovered }
      return summary
    } else if (state.state === "sleeping") {
      yield* Effect.logWarning(
        `[llamacpp-discover] ${state.note} — keeping last inventory${inventory.current ? ` (from ${new Date(inventory.current.at).toISOString()})` : " (none yet)"}`,
      )
      return "kept last inventory (sleeping)"
    } else {
      yield* Effect.logWarning(
        `[llamacpp-discover] unreachable (${state.errors.join("; ")}) — keeping last inventory${inventory.current ? ` (from ${new Date(inventory.current.at).toISOString()})` : " (none yet)"}`,
      )
      return "kept last inventory (unreachable)"
    }
  })

// ---------------------------------------------------------------------------
// Triggers: /llama-refresh command + config.updated fast path
// ---------------------------------------------------------------------------

// Simple concurrency guard: a second refresh while one is running is ignored.
let refreshing = false

/** Log a startup/refresh failure without killing the plugin (Effect.result). */
const logOnFailure = (r: Result.Result<unknown, unknown>, label: string): Effect.Effect<void> =>
  Result.isSuccess(r) ? Effect.void : Effect.logWarning(`[llamacpp-discover] ${label} failed`, { error: String(r.failure) })

/**
 * Register the two non-startup triggers. No polling anywhere.
 * - Trigger 2: `/llama-refresh` — add-only command transform; the executor
 *   runs the full pipeline and confirms via a synthetic session message.
 * - Trigger 3: `config.updated` — event stream, debounced 250 ms, forked in
 *   the plugin scope. Option A: re-applies the cached discovered models with
 *   NO HTTP round-trip (the config overlay is OpenCode's job); if no successful
 *   discovery has happened yet, falls back to a full refresh.
 */
const registerTriggers = (ctx: Ctx, options: Options): Effect.Effect<void> =>
  Effect.gen(function* () {
    // --- Trigger 2: /llama-refresh -----------------------------------------
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "llama-refresh",
        description: "Re-discover models loaded in the local llama-server",
        execute: (input) =>
          Effect.gen(function* () {
            if (refreshing) {
              yield* ctx.session
                .synthetic({ sessionID: input.sessionID, text: "llama-refresh: a refresh is already running — ignored", resume: false })
                .pipe(Effect.orDie)
              return
            }
            refreshing = true
            const summary = yield* runRefresh(ctx, options).pipe(
              Effect.ensuring(Effect.sync(() => { refreshing = false })),
            )
            yield* ctx.session
              .synthetic({ sessionID: input.sessionID, text: `llama-refresh: ${summary}`, resume: false })
              .pipe(Effect.orDie)
          }),
      })
    })
    yield* ctx.command.reload()

    // --- Trigger 3: config.updated -----------------------------------------
    if (options.refreshOnConfigUpdate !== false) {
      yield* ctx.event.subscribe().pipe(
        Stream.filter((item) => item.type === "config.updated"),
        Stream.debounce(Schedule.spaced("250 millis")),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const cached = inventory.current
            if (!cached || cached.state.state !== "ok") {
              yield* Effect.logInfo("[llamacpp-discover] config changed before first discovery — running full refresh")
              yield* runRefresh(ctx, options).pipe(Effect.result, Effect.tap((r) => logOnFailure(r, "refresh")))
              return
            }
            const { existing } = yield* readProviderState(ctx, options)
            yield* apply(ctx, cached.discoveredModels, cached.state, existing, options, [])
            yield* Effect.logInfo("[llamacpp-discover] config updated — re-applied discovered models from cache (no HTTP)")
          }).pipe(Effect.result, Effect.tap((r) => logOnFailure(r, "config fast path"))),
        ),
        Effect.forkScoped,
      )
    }
  })

// ---------------------------------------------------------------------------
// Plugin entry (the single export)
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "llamacpp-discover",
  effect: (ctx) =>
    Effect.gen(function* () {
      const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
      const options: Options = {
        providerID: env.LLAMACPP_DISCOVER_PROVIDER_ID || "llama",
        providerName: "Local llama.cpp",
        baseURL: env.LLAMACPP_DISCOVER_BASE_URL || "http://127.0.0.1:8080/v1",
        outputLimit: 8192,
        disabled: false,
        refreshOnConfigUpdate: true,
        ...ctx.options,
      }
      if (options.disabled) {
        yield* Effect.logWarning("[llamacpp-discover] disabled via options — plugin inactive")
        return
      }
      yield* Effect.logInfo("[llamacpp-discover] loaded", {
        providerID: options.providerID,
        baseURL: options.baseURL,
      })
      yield* runRefresh(ctx as unknown as Ctx, options).pipe(
        Effect.result,
        Effect.tap((r) => logOnFailure(r, "startup refresh")),
        Effect.forkScoped,
      )
      yield* registerTriggers(ctx as unknown as Ctx, options)
      yield* Effect.addFinalizer(() => Effect.logInfo("[llamacpp-discover] unloaded"))
    }),
})
