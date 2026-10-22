#!/usr/bin/env node
/**
 * MCP server (stdio) untuk Claude Desktop / Claude Code.
 * Env: DELOVA_HUB_URL (mis. https://hub.delova.id), DELOVA_HUB_TOKEN (API token dari menu Tim).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from '../src/mcp-tools.js';

const base = (process.env.DELOVA_HUB_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.DELOVA_HUB_TOKEN;
if (!token) {
  console.error('DELOVA_HUB_TOKEN belum diisi. Buat API token di dashboard → Tim.');
  process.exit(1);
}

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let role = 'editor';
try {
  role = (await call('GET', '/api/me')).role;
} catch (e) {
  console.error(`Peringatan: tidak bisa membaca profil dari ${base} (${e.message}). Tool manajer tidak ditampilkan.`);
}

const server = new McpServer({ name: 'delova-threads-hub', version: '1.0.0' });
registerTools(server, call, { role });
await server.connect(new StdioServerTransport());
