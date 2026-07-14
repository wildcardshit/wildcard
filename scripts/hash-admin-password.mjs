#!/usr/bin/env node
/* ==========================================================================
   WILDCARD — Admin password hash generator
   Run locally (plain Node, no dependencies): `node scripts/hash-admin-password.mjs`

   Prompts for the admin password you want to log in with, hashes it with
   PBKDF2-HMAC-SHA256 (same algorithm/params functions/_auth.js verifies
   against on the Workers side, since Web Crypto's PBKDF2 and Node's are
   both the standard algorithm and interoperate on identical inputs), and
   prints the values to set as Cloudflare Pages secrets:

     wrangler pages secret put ADMIN_USERNAME --project-name=<your-project>
     wrangler pages secret put ADMIN_PASSWORD_HASH --project-name=<your-project>
     wrangler pages secret put ADMIN_SESSION_SECRET --project-name=<your-project>

   or paste them into the Pages dashboard under Settings > Environment
   variables (mark each as Encrypted), or into your local .dev.vars for
   `wrangler pages dev`.

   The plaintext password is never written to disk by this script — only
   typed at the prompt and immediately hashed in memory. Still, run it on a
   machine you trust and don't paste the plaintext anywhere else.
   ========================================================================== */

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const ITERATIONS = 210000; // must match PBKDF2_ITERATIONS_DEFAULT in functions/_auth.js's spirit — the iteration count is actually stored IN the hash string, so this only needs to be a reasonable value, not an exact match

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = function (stringToWrite) {
      if (rl.stdoutMuted) rl.output.write('*');
      else rl.output.write(stringToWrite);
    };
    rl.question(query, (value) => {
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    });
    rl.stdoutMuted = true;
  });
}

// A single prompt (no confirmation re-entry) keeps this robust across
// terminals/piped input — if you mistype, just run the script again and
// re-set the secret.
const password = await askHidden('Choose an admin password (min 12 characters): ');

if (!password || password.length < 12) {
  console.error('Password must be at least 12 characters. Run the script again.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const stored = `pbkdf2-sha256$${ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
const sessionSecret = randomBytes(32).toString('hex');

console.log('\nSet these as encrypted Cloudflare Pages secrets:\n');
console.log('ADMIN_USERNAME=<pick any username, e.g. admin>');
console.log('ADMIN_PASSWORD_HASH=' + stored);
console.log('ADMIN_SESSION_SECRET=' + sessionSecret);
console.log('\nSee functions/README.md for how to set these via wrangler or the Pages dashboard.');
