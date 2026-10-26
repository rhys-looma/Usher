import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';

const schema = JSON.parse(await readFile(new URL('../../../spec/map.schema.json', import.meta.url), 'utf8'));

// Ajv's strict lints that the spec schema deliberately trips: if/then blocks requiring
// properties declared on the parent, and union types (min/max are numbers or date strings).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
// RFC 3339 date-time, the only format the schema uses.
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i);
const validate = ajv.compile(schema);

/** Validates a map against spec/map.schema.json; returns null when valid, else the errors. */
export function mapSchemaErrors(map: unknown): string | null {
  return validate(map) ? null : ajv.errorsText(validate.errors, { separator: '\n' });
}
