// Generates an Apple Music developer token from a MusicKit private key.
//
// Run it yourself: the .p8 is a private key and must not leave your machine, and
// the token it prints is a credential too. Paste the token straight into the
// Cloudflare secret; nobody needs to see either value.
//
//   node tools/make-apple-token.mjs ~/Keys/AuthKey_XXXXXXXXXX.p8 <KEY_ID> <TEAM_ID>
//
// Apple caps developer tokens at six months. When /resolve starts answering
// "token expired", run this again and replace the secret.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const [, , keyPath, keyId, teamId] = process.argv;
if (!keyPath || !keyId || !teamId) {
  console.error('usage: node tools/make-apple-token.mjs <path-to.p8> <KEY_ID> <TEAM_ID>');
  process.exit(1);
}

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64url');

const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
const payload = b64({ iss: teamId, iat: now, exp: now + 15777000 }); // ~6 months
const signingInput = `${header}.${payload}`;

const signer = createSign('SHA256');
signer.update(signingInput);
signer.end();
const signature = signer.sign(
  { key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' }
).toString('base64url');

console.log(`${signingInput}.${signature}`);
console.error(`\nExpires ${new Date((now + 15777000) * 1000).toISOString().slice(0, 10)}`);
