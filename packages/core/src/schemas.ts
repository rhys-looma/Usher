// JSON Schema validation of maps and knock documents against the specs (Node only).

import { Ajv2020 } from 'ajv/dist/2020.js';
// Imported, not read from disk, so bundles (@usher-run/mcp) carry them.
import mapSchema from '../../../spec/map.schema.json' with { type: 'json' };
import knockSchema from '../../../spec/knock.schema.json' with { type: 'json' };
import policySchema from '../../../spec/policy.schema.json' with { type: 'json' };
import planSchema from '../../../spec/plan.schema.json' with { type: 'json' };

// Ajv's strict lints that the spec schemas deliberately trip: if/then blocks requiring
// properties declared on the parent, and union types (min/max are numbers or date strings).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, schemas: [mapSchema, knockSchema, policySchema, planSchema] });
// RFC 3339 date-time and absolute URIs, the only formats the schemas use.
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i);
ajv.addFormat('uri', /^[a-z][a-z0-9+.-]*:[^\s]*$/i);

function errorsFor(id: string, doc: unknown): string | null {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`No schema ${id}`);
  return validate(doc) ? null : ajv.errorsText(validate.errors, { separator: '\n' });
}

/** Validates a map against spec/map.schema.json; returns null when valid, else the errors. */
export function mapSchemaErrors(map: unknown): string | null {
  return errorsFor(mapSchema.$id, map);
}

/** Validates a document against one definition in spec/knock.schema.json, e.g. "knockRequest". */
export function knockSchemaErrors(def: string, doc: unknown): string | null {
  return errorsFor(`${knockSchema.$id}#/$defs/${def}`, doc);
}

/** Validates a policy against spec/policy.schema.json. */
export function policySchemaErrors(policy: unknown): string | null {
  return errorsFor(policySchema.$id, policy);
}

/** Validates a plan against spec/plan.schema.json. */
export function planSchemaErrors(plan: unknown): string | null {
  return errorsFor(planSchema.$id, plan);
}
