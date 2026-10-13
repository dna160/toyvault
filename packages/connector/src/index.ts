#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { ConnectorService } from "./service.js";
import { registerTools } from "./tools.js";

// stdout carries the MCP protocol; diagnostics go to stderr only.
const cfg = loadConfig();
const service = new ConnectorService(cfg, new ApiClient(cfg.apiBaseUrl, cfg.token));

const server = new McpServer({ name: "toyvault", version: "0.1.0" });
registerTools(server, service);

await server.connect(new StdioServerTransport());
console.error(`[toyvault] connector ready · inbox ${cfg.inboxDir} · api ${cfg.apiBaseUrl}`);
