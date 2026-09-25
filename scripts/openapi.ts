// Writes openapi.json from the registered routes. `--check` fails if the committed file is stale.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildApp } from "@/app";

const app = await buildApp({ docs: true });
await app.ready();
const spec = JSON.stringify(app.swagger(), null, 2) + "\n";
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
