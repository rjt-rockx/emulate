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
