#!/usr/bin/env node
/**
 * auth.js — One-time OAuth 2.0 (3LO) flow for Confluence Cloud.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials.
 *   2. node auth.js
 *   3. Authorise in the browser that opens.
 *   4. Tokens are saved to ~/.confluence-mcp/tokens.json (mode 600).
 */

import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";
import open from "open";

// ── Config ────────────────────────────────────────────────────────────────────

const CLIENT_ID = process.env.CONFLUENCE_CLIENT_ID;
const CLIENT_SECRET = process.env.CONFLUENCE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:8080/callback";
const PORT = 8080;
const SCOPES = [
	"read:confluence-content.all",
	"read:confluence-space.summary",
	"write:confluence-content",
	"offline_access",
].join(" ");

const TOKEN_DIR = path.join(os.homedir(), ".confluence-mcp");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.json");

// ── Validation ────────────────────────────────────────────────────────────────

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error(
		"Error: CONFLUENCE_CLIENT_ID and CONFLUENCE_CLIENT_SECRET must be set in .env",
	);
	process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveTokens(tokens) {
	fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
		mode: 0o600,
	});
	// Enforce 600 in case the file already existed with looser permissions.
	fs.chmodSync(TOKEN_FILE, 0o600);
}

async function exchangeCode(code) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		client_secret: CLIENT_SECRET,
		code,
		redirect_uri: REDIRECT_URI,
	});

	const res = await fetch("https://auth.atlassian.com/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${text}`);
	}

	return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────

const authUrl = new URL("https://auth.atlassian.com/authorize");
authUrl.searchParams.set("audience", "api.atlassian.com");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("prompt", "consent");

console.log("Opening browser for Atlassian authorisation…");
console.log(`Auth URL: ${authUrl.toString()}\n`);

await open(authUrl.toString());

// Start callback server
await new Promise((resolve, reject) => {
	const server = http.createServer(async (req, res) => {
		if (!req.url?.startsWith("/callback")) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
		const code = params.get("code");
		const error = params.get("error");

		if (error) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(
				`<h1>Auth error: ${error}</h1><p>${params.get("error_description") ?? ""}</p>`,
			);
			server.close();
			reject(
				new Error(
					`Auth error: ${error} — ${params.get("error_description") ?? ""}`,
				),
			);
			return;
		}

		if (!code) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end("<h1>Missing code parameter</h1>");
			server.close();
			reject(new Error("No code parameter in callback"));
			return;
		}

		try {
			const tokenData = await exchangeCode(code);

			const tokens = {
				access_token: tokenData.access_token,
				refresh_token: tokenData.refresh_token,
				expires_at: Date.now() + tokenData.expires_in * 1000,
				scope: tokenData.scope,
			};

			saveTokens(tokens);

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<h1>Authorisation successful!</h1><p>You can close this tab and return to the terminal.</p>",
			);

			console.log(`\nTokens saved to ${TOKEN_FILE}`);
			console.log(
				'Run "node server.js" (or configure mcp.json) to start the MCP server.',
			);

			server.close();
			resolve();
		} catch (err) {
			res.writeHead(500, { "Content-Type": "text/html" });
			res.end(`<h1>Error</h1><pre>${err.message}</pre>`);
			server.close();
			reject(err);
		}
	});

	server.on("error", reject);
	server.listen(PORT, () => {
		console.log(`Waiting for callback on http://localhost:${PORT}/callback …`);
	});
});
