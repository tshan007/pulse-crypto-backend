import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Picks .env.{APP_ENV} (default "development"), falling back to plain .env if that
// file doesn't exist. Set via `cross-env` in the package.json script aliases; resolved
// off process.cwd() (repo root) so it works regardless of which package is running.
const appEnv = process.env.APP_ENV ?? "development";
const candidate = `.env.${appEnv}`;
const resolved = path.resolve(process.cwd(), candidate);

if (fs.existsSync(resolved)) {
  dotenv.config({ path: resolved });
  console.log(`[env] loaded ${candidate}`);
} else {
  dotenv.config();
  console.warn(`[env] ${candidate} not found, fell back to .env`);
}
