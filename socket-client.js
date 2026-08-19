// Headless CLI — npm run client
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const { load, validate } = require("./lib/config");
const { createClient } = require("./lib/client");

const config = load();
const errors = validate(config, { requireReady: true });
if (errors.length) {
  for (const err of errors) console.error(`❌ ${err}`);
  console.error("Copy .env.example to .env and fill in ACCESS_TOKEN + CAMPAIGN_SESSION_ID.");
  process.exit(1);
}

const client = createClient();

function shutdown(signal) {
  client.stop(signal);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.start(config);
