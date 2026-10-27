import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function issueSpecHash({ title, body }) {
  if (typeof title !== 'string' || (body != null && typeof body !== 'string')) {
    throw new TypeError('Expected issue title string and body string or null');
  }
  return createHash('sha256').update(title + '\0' + (body ?? ''), 'utf8').digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let json = '';
  for await (const chunk of process.stdin) json += chunk;
  process.stdout.write(issueSpecHash(JSON.parse(json)) + '\n');
}
