const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

// localhost / demo: .env.dev (default). prod server: NODE_ENV=prod (pm2) loads .env.prod, else .env
const NODE_ENV = process.env.NODE_ENV === "prod" ? "prod" : process.env.NODE_ENV === "test" ? "test" : "dev";
process.env.NODE_ENV = NODE_ENV;

if (NODE_ENV !== "test") {
  const envPath = path.resolve(__dirname, "..", `.env.${NODE_ENV}`);
  const defaultEnvPath = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true, quiet: true });
    console.log(`Startup | environment: ${NODE_ENV}, loaded settings from ${envPath}`);
  } else if (fs.existsSync(defaultEnvPath)) {
    dotenv.config({ path: defaultEnvPath, override: true, quiet: true });
    console.log(`Startup | environment: ${NODE_ENV}, .env.${NODE_ENV} not found, loaded .env`);
  } else {
    console.log(`Startup | environment: ${NODE_ENV}, no .env file found, using system environment variables`);
  }
}

module.exports = { NODE_ENV };
