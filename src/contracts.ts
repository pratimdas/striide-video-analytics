import { readFileSync } from 'node:fs';
import Ajv2020Mod from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { fromRoot } from './util/paths.js';

const Ajv2020: any = (Ajv2020Mod as any).default ?? Ajv2020Mod;

export type ContractName = 'discovery' | 'inspection' | 'lab-contract' | 'trace-span';
const cache = new Map<ContractName, { schema: any; validate: ValidateFunction }>();

/** Canonical contracts from the pack, compiled once. Provider outputs are always validated locally against these. */
export function contract(name: ContractName): { schema: any; validate: ValidateFunction } {
  let c = cache.get(name);
  if (!c) {
    const schema = JSON.parse(readFileSync(fromRoot('contracts', `${name}.schema.json`), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    c = { schema, validate: ajv.compile(schema) };
    cache.set(name, c);
  }
  return c;
}

export function validateContract(name: ContractName, value: unknown): { ok: boolean; errors: string[] } {
  const { validate } = contract(name);
  const ok = validate(value) as boolean;
  return { ok, errors: ok ? [] : (validate.errors ?? []).slice(0, 20).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`) };
}
