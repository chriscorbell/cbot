/**
 * Forgets the account, for a forgotten password: `node server/dist/reset-account.js` with the server's
 * DATA_DIR (or `npm run reset-account -w server` in a checkout). Every browser is signed out and the
 * next visit asks for a new account, made with the setup code this prints. Bots, chats and everything
 * else stay. The server may keep running.
 */
import { resetAccount } from './lib/auth.js';
import { env } from './env.js';

const code = resetAccount();
console.log(`Account cleared in ${env.dbPath}. The next visit to Dispatch asks for a new one, with the setup code ${code}.`);
