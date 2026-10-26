import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { knockSchemaErrors } from '../src/schemas.ts';

const examples = new URL('../../../spec/examples/knock/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, examples), 'utf8'));
const camel = (file: string) => file.replace(/\.json$/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

test('every example in spec/examples/knock validates against its definition', async () => {
  const files = (await readdir(examples)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const def = file === 'keys.json' ? 'keySet' : camel(file);
    assert.equal(knockSchemaErrors(def, await read(file)), null, file);
  }
});

test('the schema rejects extra members, values in events and private keys', async () => {
  const knock = await read('knock-request.json');
  assert.notEqual(knockSchemaErrors('knockRequest', { ...knock, cookie: 'abc' }), null, 'extra member');
  assert.notEqual(knockSchemaErrors('knockRequest', { ...knock, url: `${knock.url}?email=sam@example.com` }), null, 'query string');
  const { signature: _, ...unsigned } = knock;
  assert.notEqual(knockSchemaErrors('knockRequest', unsigned), null, 'unsigned');

  const events = await read('events.json');
  const withValue = structuredClone(events);
  withValue.events[1].value = 'Sam';
  assert.notEqual(knockSchemaErrors('events', withValue), null, 'event carrying a value');

  const keys = await read('keys.json');
  assert.notEqual(knockSchemaErrors('keySet', { keys: [{ ...keys.keys[0], d: keys.keys[0].x }] }), null, 'private key published');

  const claims = await read('token-claims.json');
  const { jti: __, ...noJti } = claims;
  assert.notEqual(knockSchemaErrors('tokenClaims', noJti), null, 'claims without jti');
  assert.equal(knockSchemaErrors('tokenClaims', { ...claims, map: null }), null, 'no map is allowed');
});
