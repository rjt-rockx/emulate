import { readFileSync } from "node:fs";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Conformance oracle: validates emulator REST responses against Discord's official OpenAPI 3.1
 * spec (vendored at ./openapi.json). The spec is an INDEPENDENT ground truth — unlike our
 * hand-written assertions, it cannot encode our own bugs, so a mismatch is a real divergence.
 */

interface OpenAPISpec {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, unknown>; responses?: Record<string, unknown> };
}
interface OperationObject {
  responses: Record<string, { $ref?: string; content?: Record<string, { schema?: unknown }> }>;
}

const SPEC_ID = "https://discord.com/openapi.json";
const spec: OpenAPISpec = JSON.parse(readFileSync(new URL("./openapi.json", import.meta.url), "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, allowUnionTypes: true });
addFormats(ajv);
// Register the whole document so every `#/components/...` $ref resolves against one base URI.
ajv.addSchema(spec, SPEC_ID);

/** Escape a string for use as a single JSON Pointer reference token. */
function ptr(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Resolve a JSON Pointer (no leading-fragment `#`) within the spec document. */
function resolvePointer(pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((node, raw) => {
      if (node == null || typeof node !== "object") return undefined;
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      return (node as Record<string, unknown>)[key];
    }, spec);
}

const validatorCache = new Map<string, ValidateFunction | null>();

/**
 * Build (or fetch a cached) validator for the JSON response body of a spec operation.
 * Returns null when the operation declares no JSON schema for that status (e.g. 204).
 */
function responseValidator(specPath: string, method: string, status: number): ValidateFunction | null {
  const op = spec.paths[specPath]?.[method.toLowerCase()];
  if (!op) return null;

  // Pick the response object: exact status, then the NXX class, then `default`.
  const statusKey = String(status);
  const classKey = `${statusKey[0]}XX`;
  const respKey = op.responses[statusKey] ? statusKey : op.responses[classKey] ? classKey : op.responses.default ? "default" : null;
  if (!respKey) return null;

  // The schema may live inline on the operation, or behind a `#/components/responses/*` $ref.
  const resp = op.responses[respKey];
  const basePointer = resp.$ref
    ? resp.$ref.replace(/^#/, "")
    : `/paths/${ptr(specPath)}/${method.toLowerCase()}/responses/${ptr(respKey)}`;
  const schemaPointer = `${basePointer}/content/${ptr("application/json")}/schema`;
  if (resolvePointer(schemaPointer) === undefined) return null;

  const cacheKey = schemaPointer;
  if (validatorCache.has(cacheKey)) return validatorCache.get(cacheKey)!;
  // Wrap as a $ref so all nested `#/components/schemas/*` refs resolve against the spec root.
  const validate = ajv.compile({ $ref: `${SPEC_ID}#${schemaPointer}` });
  validatorCache.set(cacheKey, validate);
  return validate;
}

/** All spec path templates, pre-split, sorted so the most literal (fewest params) wins. */
const SPEC_PATHS = Object.keys(spec.paths)
  .map((p) => ({ template: p, segs: p.split("/").filter(Boolean) }))
  .sort((a, b) => a.segs.filter((s) => s.startsWith("{")).length - b.segs.filter((s) => s.startsWith("{")).length);

/**
 * Match a concrete request path (e.g. `/api/v10/channels/123/messages`) to a spec path template
 * (`/channels/{channel_id}/messages`). Returns null when no template matches.
 */
export function matchSpecPath(rawPath: string): string | null {
  const path = rawPath.split("?")[0].replace(/^\/api\/v\d+/, "");
  const segs = path.split("/").filter(Boolean);
  for (const { template, segs: tsegs } of SPEC_PATHS) {
    if (tsegs.length !== segs.length) continue;
    if (tsegs.every((t, i) => t.startsWith("{") || t === segs[i])) return template;
  }
  return null;
}

export interface ConformanceResult {
  matched: boolean;
  specPath: string | null;
  validated: boolean;
  errors: string[];
}

/**
 * Validate one emulator response body against the spec. `path` is the concrete request path
 * (with or without the `/api/vN` prefix). A body is "validated" only when the spec has a matching
 * operation + JSON response schema; otherwise `validated` is false (no oracle for it).
 */
export function checkResponse(method: string, path: string, status: number, body: unknown): ConformanceResult {
  const specPath = matchSpecPath(path);
  if (!specPath) return { matched: false, specPath: null, validated: false, errors: [] };
  const validate = responseValidator(specPath, method, status);
  if (!validate) return { matched: true, specPath, validated: false, errors: [] };
  const ok = validate(body);
  const errors = ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}${e.params && Object.keys(e.params).length ? " " + JSON.stringify(e.params) : ""}`);
  return { matched: true, specPath, validated: true, errors };
}

type JsonSchema = Record<string, unknown>;

/** Resolve a `$ref` (or return the schema as-is) one level. */
function deref(schema: JsonSchema): JsonSchema {
  const ref = schema.$ref as string | undefined;
  if (typeof ref === "string") return (resolvePointer(ref.replace(/^#/, "")) as JsonSchema) ?? {};
  return schema;
}

/** Resolve a concrete snowflake for an id-shaped body field (e.g. `recipient_id`, `sku_id`). */
export type IdResolver = (fieldName: string) => string | undefined;

/** Generate a minimal value satisfying a (subset of) JSON Schema, for synthesizing request bodies. */
function genFromSchema(raw: JsonSchema | undefined, depth: number, key: string | undefined, idFor: IdResolver | undefined): unknown {
  if (!raw || depth > 6) return undefined;
  const schema = deref(raw);
  if (Array.isArray(schema.enum)) return schema.enum.find((v) => v !== null);
  if (Array.isArray(schema.oneOf)) return genFromSchema(schema.oneOf[0] as JsonSchema, depth + 1, key, idFor);
  if (Array.isArray(schema.anyOf)) return genFromSchema(schema.anyOf[0] as JsonSchema, depth + 1, key, idFor);
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf as JsonSchema[]) {
      const v = genFromSchema(part, depth + 1, key, idFor);
      if (v && typeof v === "object") Object.assign(merged, v);
    }
    return merged;
  }
  let type = schema.type as string | string[] | undefined;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  switch (type) {
    case "string": {
      // Snowflake-shaped id fields: resolve to a real id when one is available.
      if (key && /(_id|_ids)$/.test(key) && idFor) {
        const resolved = idFor(key.replace(/s$/, ""));
        if (resolved) return resolved;
      }
      if (schema.format === "date-time") return new Date(Date.now() + 86_400_000).toISOString();
      if (schema.format === "uri") return "https://example.com";
      const min = (schema.minLength as number) ?? 0;
      return "oracle".padEnd(Math.max(min, 1), "x").slice(0, (schema.maxLength as number) ?? 32);
    }
    case "integer":
    case "number":
      return (schema.minimum as number) ?? 1;
    case "boolean":
      return false;
    case "array":
      return (schema.minItems as number) ? [genFromSchema(schema.items as JsonSchema, depth + 1, key, idFor)] : [];
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (schema.properties as Record<string, JsonSchema>) ?? {};
      for (const k of (schema.required as string[]) ?? []) out[k] = genFromSchema(props[k], depth + 1, k, idFor);
      return out;
    }
    default:
      return type === undefined && schema.properties ? genFromSchema({ ...schema, type: "object" }, depth, key, idFor) : undefined;
  }
}

/** Synthesize a minimal valid JSON request body for an operation, or null when it has none. */
export function generateRequestBody(specPath: string, method: string, idFor?: IdResolver): unknown {
  const op = spec.paths[specPath]?.[method.toLowerCase()] as { requestBody?: { content?: Record<string, { schema?: JsonSchema }> } } | undefined;
  const schema = op?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return null;
  return genFromSchema(schema, 0, undefined, idFor);
}

// Over-emission audit
//
// The OpenAPI oracle catches MISSING/wrong fields, but not OVER-emission: Discord's response
// objects omit `additionalProperties:false`, so ajv permits any extra key. Yet Discord's schemas
// DO enumerate every real field, so an emitted key absent from a schema's declared `properties`
// is almost always a fidelity bug (a field real Discord never returns). This audit flags those,
// while respecting explicit `additionalProperties` (genuine map types like `metadata`/`nicks`).

interface ObjectShape {
  props: Record<string, JsonSchema>;
  /** True when the schema explicitly permits arbitrary keys (a map type) — don't flag extras. */
  open: boolean;
}

/** Merge an object schema (through allOf/oneOf/anyOf/$ref) into its declared property set. */
function objectShape(raw: JsonSchema, depth: number): ObjectShape {
  if (depth > 8) return { props: {}, open: true };
  const schema = deref(raw);
  const props: Record<string, JsonSchema> = {};
  let open = false;
  const merge = (s: JsonSchema): void => {
    const sh = objectShape(s, depth + 1);
    Object.assign(props, sh.props);
    open = open || sh.open;
  };
  for (const part of (schema.allOf as JsonSchema[]) ?? []) merge(part);
  for (const branch of (schema.oneOf as JsonSchema[]) ?? []) merge(branch);
  for (const branch of (schema.anyOf as JsonSchema[]) ?? []) merge(branch);
  if (schema.properties) Object.assign(props, schema.properties as Record<string, JsonSchema>);
  const ap = schema.additionalProperties;
  if (ap === true || (ap != null && typeof ap === "object")) open = true;
  return { props, open };
}

/** Pick, among oneOf/anyOf branches, the property schema that declares `key` (for recursion). */
function propSchemaFor(raw: JsonSchema, key: string, depth: number): JsonSchema | undefined {
  return objectShape(raw, depth).props[key];
}

function walkUnknown(raw: JsonSchema, instance: unknown, path: string, out: string[], depth: number): void {
  if (instance == null || depth > 8) return;
  const schema = deref(raw);
  if (Array.isArray(instance)) {
    const items = schema.items as JsonSchema | undefined;
    if (items) instance.forEach((it, i) => walkUnknown(items, it, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof instance !== "object") return;
  const { props, open } = objectShape(schema, 0);
  // Only audit objects the spec actually describes with named properties.
  if (Object.keys(props).length === 0) return;
  for (const [k, v] of Object.entries(instance as Record<string, unknown>)) {
    const child = k in props ? props[k] : propSchemaFor(schema, k, 0);
    if (child) walkUnknown(child, v, path ? `${path}.${k}` : k, out, depth + 1);
    else if (!open) out.push(path ? `${path}.${k}` : k);
  }
}

/** Resolve the raw JSON response schema for an operation+status, or null when none is declared. */
function responseSchema(specPath: string, method: string, status: number): JsonSchema | null {
  const op = spec.paths[specPath]?.[method.toLowerCase()];
  if (!op) return null;
  const statusKey = String(status);
  const classKey = `${statusKey[0]}XX`;
  const respKey = op.responses[statusKey] ? statusKey : op.responses[classKey] ? classKey : op.responses.default ? "default" : null;
  if (!respKey) return null;
  const resp = op.responses[respKey];
  const basePointer = resp.$ref ? resp.$ref.replace(/^#/, "") : `/paths/${ptr(specPath)}/${method.toLowerCase()}/responses/${ptr(respKey)}`;
  const schema = resolvePointer(`${basePointer}/content/${ptr("application/json")}/schema`);
  return schema === undefined ? null : (schema as JsonSchema);
}

/**
 * Flag response keys the emulator emits that the spec's schema never declares (over-emission).
 * Array indices in the returned paths are normalized to `[]` and de-duplicated.
 */
export function findOverEmission(method: string, path: string, status: number, body: unknown): string[] {
  const specPath = matchSpecPath(path);
  if (!specPath) return [];
  const schema = responseSchema(specPath, method, status);
  if (!schema) return [];
  const out: string[] = [];
  walkUnknown(schema, body, "", out, 0);
  return [...new Set(out.map((p) => p.replace(/\[\d+\]/g, "[]")))];
}

/** Spec operations (method + path) the spec defines, for coverage reporting. */
export function specOperations(): Array<{ method: string; path: string }> {
  const ops: Array<{ method: string; path: string }> = [];
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const m of Object.keys(methods)) {
      if (["get", "post", "put", "patch", "delete"].includes(m)) ops.push({ method: m.toUpperCase(), path: p });
    }
  }
  return ops;
}
