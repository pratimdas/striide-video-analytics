import { TOOL_NAMES } from '../toolhost.js';

export const MAX_PROGRAM_CHARS = 40000;

/**
 * Static policy for generated programs (first layer; the Deno permission sandbox is the second).
 * Rejects imports, runtime/global access, code generation and unknown tools. Fails closed: a
 * false positive only causes a repair turn or the reviewed program to be used.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bimport\b/, 'import syntax (static or dynamic) is not allowed'],
  [/\brequire\b/, 'require is not allowed'],
  [/\bDeno\b/, 'Deno runtime APIs are not available to programs'],
  [/\b(globalThis|window|self|global)\b/, 'global object access is not allowed'],
  [/\b(eval|Function|AsyncFunction)\b/, 'code generation from strings is not allowed'],
  [/\b(fetch|WebSocket|XMLHttpRequest|EventSource|Worker|SharedWorker|BroadcastChannel)\b/, 'network and worker APIs are not available; use tools'],
  [/\b(process|Bun|navigator|location|caches|localStorage|sessionStorage|indexedDB)\b/, 'host/browser runtime objects are not available'],
  [/\b(constructor|prototype|__proto__|__defineGetter__|__defineSetter__|__lookupGetter__)\b/, 'prototype manipulation is not allowed'],
  [/\b(Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer)\b/, 'reflection, WebAssembly and shared memory are not allowed'],
  [/\b(setInterval|queueMicrotask)\b/, 'background scheduling is not allowed'],
  [/\\u\{?[0-9a-fA-F]/, 'unicode escape sequences are not allowed in programs'],
  [/\bcypher\b|\bMATCH\s*\(|\bGRAPH\./i, 'arbitrary graph queries are not allowed'],
];

export interface ValidationResult { ok: boolean; errors: string[]; tools_referenced: string[] }

export function validateProgram(src: string): ValidationResult {
  const errors: string[] = [];
  if (typeof src !== 'string' || !src.trim()) return { ok: false, errors: ['program is empty'], tools_referenced: [] };
  if (src.length > MAX_PROGRAM_CHARS) errors.push(`program exceeds ${MAX_PROGRAM_CHARS} characters`);
  if (!/^\s*(\/\/[^\n]*\n\s*)*async\s+function\s+program\s*\(\s*tools\s*,\s*input\s*\)\s*\{/.test(src)) errors.push('program must start with: async function program(tools, input) {');
  for (const [re, why] of FORBIDDEN) if (re.test(src)) errors.push(why);
  const referenced = [...src.matchAll(/\btools\s*\.\s*([A-Za-z]+)\s*\.\s*([A-Za-z]+)/g)].map((m) => `${m[1]}.${m[2]}`);
  for (const t of new Set(referenced)) if (!(TOOL_NAMES as readonly string[]).includes(t)) errors.push(`unknown tool ${t}`);
  if (/\btools\s*\[/.test(src)) errors.push('computed tool access (tools[...]) is not allowed; call tools by name');
  if (/\btools\s*\.\s*[A-Za-z]+\s*\[/.test(src)) errors.push('computed tool access is not allowed; call tools by name');
  return { ok: errors.length === 0, errors: [...new Set(errors)], tools_referenced: [...new Set(referenced)] };
}

/** Convert the reviewed module (export default async function program...) to program text. */
export function reviewedProgramText(moduleSource: string): string {
  const stripped = moduleSource.replace(/^(\s*\/\/[^\n]*\n)*/, '').replace(/^\s*export\s+default\s+/m, '');
  return stripped.trim() + '\n';
}
