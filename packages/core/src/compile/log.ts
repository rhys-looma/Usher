// Compiler log (LU-19): every model request and response, one JSON line each, for the future
// fine-tuning set. Image bytes and the API key never go in; the key is not part of the request.

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest } from './model.ts';

/** The request with each image's data URL replaced by its type, size and hash. */
export function redactRequest(request: ChatRequest, describe: (url: string) => string = describeImage): ChatRequest {
  return {
    ...request,
    messages: request.messages.map((m) =>
      typeof m.content === 'string'
        ? m
        : { ...m, content: m.content.map((part) => (part.type === 'image_url' ? { ...part, image_url: { url: describe(part.image_url.url) } } : part)) },
    ),
  };
}

function describeImage(url: string): string {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match) return '[image omitted]';
  const bytes = Buffer.from(match[2]!, 'base64');
  return `[image omitted: ${match[1]}, ${bytes.length} bytes, sha256:${createHash('sha256').update(bytes).digest('hex')}]`;
}

/** sha256 of the request with images removed: identical prompts give identical hashes. */
export function requestHash(request: ChatRequest): string {
  const text = JSON.stringify(redactRequest(request, () => '[image]'));
  return createHash('sha256').update(text).digest('hex');
}

export async function appendLog(dir: string, record: object, now: Date = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${now.toISOString().slice(0, 10)}.jsonl`);
  await appendFile(file, `${JSON.stringify(record)}\n`);
  return file;
}
