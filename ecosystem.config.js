// pm2 process file.
//   demo / dev server:  pm2 start ecosystem.config.js            -> NODE_ENV dev, loads .env.dev
//   prod server:        pm2 start ecosystem.config.js --env prod -> NODE_ENV prod, loads .env.prod or .env
// One instance only: the startup recovery (services/recovery.js) treats every lock left in the DB as belonging to a
// stopped process. kill_timeout lets a restart wait for running Oracle flows (index.js waits up to 60 s) instead of
// pm2's default 1.6 s, which would cut an Oracle call off mid-way.
module.exports = {
  apps: [
    {
      name: "onesify-opportunity",
      script: "index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      kill_timeout: 70000,
      max_memory_restart: "512M",
      env: { NODE_ENV: "dev" },
      env_prod: { NODE_ENV: "prod" },
    },
  ],
};
