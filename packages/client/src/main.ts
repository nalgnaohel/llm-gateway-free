import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadClientConfig } from "./config.ts";
import { ClientAgent } from "./agent.ts";
import { logger, setLogLevel } from "./log.ts";

export async function startClient(env: NodeJS.ProcessEnv = process.env): Promise<ClientAgent> {
  const cfg = loadClientConfig(env);
  setLogLevel(cfg.logLevel);
  const log = logger("client");
  log.info(`agent ${cfg.agentId} (${cfg.name})`);
  log.info(`  server   ${cfg.serverUrl}`);
  log.info(`  browser  ${cfg.browserEnabled ? cfg.cdpUrl : "disabled"}`);
  log.info(`  cli      ${cfg.cliEnabled ? `enabled (cwd ${cfg.cliCwd})` : "disabled"}`);
  const agent = new ClientAgent(cfg);
  await agent.start();
  return agent;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  startClient().then((agent) => {
    const shutdown = () => {
      agent.stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
