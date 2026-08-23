import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Which .env file gets loaded is picked by APP_ENV (e.g. "local", "uat") rather than
// always reading the plain .env. Set via the package.json script aliases
// (dev:broadcast:local, dev:broadcast:uat, ...), which set it with `cross-env` so it
// works the same on PowerShell, cmd, and bash — not something you're expected to type
// by hand.
//
// APP_ENV unset, or set to a name with no matching .env.{name} file on disk: falls
// back to plain .env, same as before this existed. So this is a no-op for anyone not
// deliberately using multiple environments.
//
// Resolved against process.cwd(), which every package.json script keeps at the repo
// root (never `npm run ... -w packages/x`) specifically so this always finds the .env
// files there regardless of which package's entrypoint is actually running.
const appEnv = process.env.APP_ENV;
const candidate = appEnv ? `.env.${appEnv}` : ".env";
const resolved = path.resolve(process.cwd(), candidate);

if (fs.existsSync(resolved)) {
  dotenv.config({ path: resolved });
  console.log(`[env] loaded ${candidate}`);
} else {
  dotenv.config();
  if (appEnv) console.warn(`[env] ${candidate} not found, fell back to .env`);
}
