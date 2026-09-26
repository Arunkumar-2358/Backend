// Writes openapi.json from the declared endpoints. `--check` fails if the committed file is stale.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildApp } from "@/app";
import { buildOpenApi } from "@/platform/openapi";

const app = await buildApp({ docs: false });
const spec = JSON.stringify(buildOpenApi(), null, 2) + "\n";
await app.close();

const file = "openapi.json";
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== spec) {
    console.error("openapi.json is out of date. Run: npm run openapi");
    process.exit(1);
  }
  console.log("openapi.json is up to date");
} else {
  writeFileSync(file, spec);
  console.log(`wrote ${file}`);
}
process.exit(0);
