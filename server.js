#!/usr/bin/env node
/**
 * server.js — Confluence Cloud MCP server (stdio transport).
 *
 * Tools exposed:
 *   confluence_search       — CQL full-text search
 *   confluence_get_page     — fetch a page's full content as plain text
 *   confluence_list_spaces  — list available Confluence spaces
 *   confluence_create_page  — create a new child page
 *   confluence_update_page  — update an existing page
 *
 * Prerequisites:
 *   1. Run `node auth.js` once to obtain tokens.
 *   2. Set CONFLUENCE_CLIENT_ID and CONFLUENCE_CLIENT_SECRET in the environment
 *      (or in a .env file next to this script).
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_FILE = path.join(os.homedir(), ".confluence-mcp", "tokens.json");
const ATLASSIAN_API = "https://api.atlassian.com";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
// Base URL for building page links (e.g. https://your-org.atlassian.net/wiki).
const CONFLUENCE_BASE_URL = (process.env.CONFLUENCE_URL ?? "").replace(
	/\/$/,
	"",
);
// Refresh if the token expires within this window (ms).
const REFRESH_BUFFER_MS = 60_000;

// ── Token management ──────────────────────────────────────────────────────────

function loadTokens() {
	if (!fs.existsSync(TOKEN_FILE)) {
		throw new Error(
			`Tokens not found at ${TOKEN_FILE}. Run "node auth.js" first.`,
		);
	}
	return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveTokens(tokens) {
	fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
		mode: 0o600,
	});
	fs.chmodSync(TOKEN_FILE, 0o600);
}

async function refreshAccessToken(tokens) {
	const clientId = process.env.CONFLUENCE_CLIENT_ID;
	const clientSecret = process.env.CONFLUENCE_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		throw new Error(
			"CONFLUENCE_CLIENT_ID and CONFLUENCE_CLIENT_SECRET must be set to refresh tokens.",
		);
	}

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: tokens.refresh_token,
	});

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Token refresh failed (${res.status}): ${text}`);
	}

	const data = await res.json();
	const newTokens = {
		access_token: data.access_token,
		refresh_token: data.refresh_token ?? tokens.refresh_token,
		expires_at: Date.now() + data.expires_in * 1000,
		scope: data.scope ?? tokens.scope,
	};
	saveTokens(newTokens);
	return newTokens;
}

async function getAccessToken() {
	let tokens = loadTokens();
	if (Date.now() >= tokens.expires_at - REFRESH_BUFFER_MS) {
		tokens = await refreshAccessToken(tokens);
	}
	return tokens.access_token;
}

// ── Cloud ID resolution ───────────────────────────────────────────────────────

let _cloudId = null;

async function getCloudId() {
	if (_cloudId) return _cloudId;

	const token = await getAccessToken();
	const res = await fetch(`${ATLASSIAN_API}/oauth/token/accessible-resources`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Failed to resolve Confluence cloud ID (${res.status}): ${text}`,
		);
	}

	const sites = await res.json();
	if (!sites.length) {
		throw new Error(
			"No accessible Atlassian sites found for this OAuth token.",
		);
	}

	// Pick the first Confluence site. If you have multiple, filter by site.url.
	_cloudId = sites[0].id;
	return _cloudId;
}

// ── Confluence REST helpers ───────────────────────────────────────────────────

async function confluenceGet(urlPath, params = {}) {
	const token = await getAccessToken();
	const cloudId = await getCloudId();
	const url = new URL(`${ATLASSIAN_API}/ex/confluence/${cloudId}${urlPath}`);

	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, String(v));
	}

	const res = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Confluence GET ${urlPath} failed (${res.status}): ${text}`,
		);
	}

	return res.json();
}

async function confluencePost(urlPath, payload) {
	const token = await getAccessToken();
	const cloudId = await getCloudId();
	const url = `${ATLASSIAN_API}/ex/confluence/${cloudId}${urlPath}`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Confluence POST ${urlPath} failed (${res.status}): ${text}`,
		);
	}

	return res.json();
}

async function confluencePut(urlPath, payload) {
	const token = await getAccessToken();
	const cloudId = await getCloudId();
	const url = `${ATLASSIAN_API}/ex/confluence/${cloudId}${urlPath}`;

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Confluence PUT ${urlPath} failed (${res.status}): ${text}`,
		);
	}

	return res.json();
}

// ── HTML → plain text (no external deps) ─────────────────────────────────────

function htmlToText(html) {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/h[1-6]>/gi, "\n\n")
		.replace(/<\/li>/gi, "\n")
		.replace(/<\/tr>/gi, "\n")
		.replace(/<\/td>/gi, "\t")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ── Wrap plain text in Confluence storage format ──────────────────────────────

function toStorageFormat(text) {
	// If the caller already sent XML/HTML tags, pass through as-is.
	if (/<[a-z][\s\S]*>/i.test(text)) return text;
	// Otherwise wrap each paragraph in <p> tags.
	return text
		.split(/\n{2,}/)
		.map((p) => `<p>${p.replace(/\n/g, "<br />").trim()}</p>`)
		.join("\n");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
	name: "confluence-mcp",
	version: "1.0.0",
});

// ── Tool: confluence_search ───────────────────────────────────────────────────

server.registerTool(
	"confluence_search",
	{
		description:
			"Search Confluence pages using CQL (Confluence Query Language). Returns matching page titles, URLs, and excerpt snippets.",
		inputSchema: {
			query: z
				.string()
				.min(1)
				.describe(
					'A CQL query string. Examples: "text ~ \\"kubernetes\\"", "space = DPT AND title ~ \\"onboarding\\"", "ancestor = 214728778"',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(10)
				.describe("Maximum number of results to return (1–50, default 10)"),
		},
	},
	async ({ query, limit }) => {
		try {
			const data = await confluenceGet("/wiki/rest/api/search", {
				cql: query,
				limit: limit ?? 10,
				expand: "content.space",
			});

			if (!data.results?.length) {
				return { content: [{ type: "text", text: "No results found." }] };
			}

			const lines = data.results.map((r, i) => {
				const page = r.content ?? r;
				const title = page.title ?? "(untitled)";
				const spaceKey = page.space?.key ?? "";
				const pageId = page.id ?? "";
				const excerpt = r.excerpt ? htmlToText(r.excerpt) : "";
				const url = `${CONFLUENCE_BASE_URL}/spaces/${spaceKey}/pages/${pageId}`;
				return `${i + 1}. [${title}](${url})\n   ID: ${pageId}${excerpt ? `\n   ${excerpt}` : ""}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Found ${data.totalSize ?? data.results.length} result(s):\n\n${lines.join("\n\n")}`,
					},
				],
			};
		} catch (err) {
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
	},
);

// ── Tool: confluence_get_page ─────────────────────────────────────────────────

server.registerTool(
	"confluence_get_page",
	{
		description:
			"Retrieve the full content of a Confluence page by its ID, returned as plain text. Also returns current version number (needed for updates).",
		inputSchema: {
			pageId: z.string().min(1).describe("The numeric Confluence page ID"),
		},
	},
	async ({ pageId }) => {
		try {
			const page = await confluenceGet(`/wiki/rest/api/content/${pageId}`, {
				expand: "body.view,version,space,ancestors",
			});

			const title = page.title ?? "(untitled)";
			const spaceKey = page.space?.key ?? "";
			const version = page.version?.number ?? 0;
			const bodyHtml = page.body?.view?.value ?? "";
			const bodyText = htmlToText(bodyHtml);
			const url = `${CONFLUENCE_BASE_URL}/spaces/${spaceKey}/pages/${pageId}`;
			const ancestors = (page.ancestors ?? []).map((a) => a.title).join(" > ");

			const output = [
				`Title:    ${title}`,
				`URL:      ${url}`,
				`Space:    ${spaceKey}`,
				`Version:  ${version}`,
				ancestors ? `Path:     ${ancestors} > ${title}` : null,
				"",
				bodyText,
			]
				.filter((l) => l !== null)
				.join("\n");

			return { content: [{ type: "text", text: output }] };
		} catch (err) {
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
	},
);

// ── Tool: confluence_list_spaces ──────────────────────────────────────────────

server.registerTool(
	"confluence_list_spaces",
	{
		description:
			"List all Confluence spaces accessible with the current token.",
		inputSchema: {},
	},
	async () => {
		try {
			const data = await confluenceGet("/wiki/rest/api/space", {
				limit: 50,
				type: "global",
			});

			if (!data.results?.length) {
				return { content: [{ type: "text", text: "No spaces found." }] };
			}

			const lines = data.results.map(
				(s) =>
					`• ${s.key.padEnd(12)} ${s.name}${s.type !== "global" ? ` (${s.type})` : ""}`,
			);

			return {
				content: [
					{
						type: "text",
						text: `${data.results.length} space(s):\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
	},
);

// ── Tool: confluence_create_page ──────────────────────────────────────────────

server.registerTool(
	"confluence_create_page",
	{
		description: [
			"Create a new Confluence page as a child of an existing page.",
			"Body can be plain text (auto-wrapped in <p> tags) or Confluence storage-format XHTML.",
			"Returns the new page ID and URL.",
		].join(" "),
		inputSchema: {
			spaceKey: z.string().min(1).describe('Space key, e.g. "DPT"'),
			parentId: z.string().min(1).describe('Parent page ID, e.g. "214728778"'),
			title: z.string().min(1).describe("Page title"),
			body: z
				.string()
				.describe(
					"Page content. Plain text is auto-converted to storage format. For rich content pass Confluence storage-format XHTML directly.",
				),
		},
	},
	async ({ spaceKey, parentId, title, body }) => {
		try {
			const storageBody = toStorageFormat(body);

			const payload = {
				type: "page",
				title,
				space: { key: spaceKey },
				ancestors: [{ id: parentId }],
				body: {
					storage: {
						value: storageBody,
						representation: "storage",
					},
				},
			};

			const page = await confluencePost("/wiki/rest/api/content", payload);

			const url = `${CONFLUENCE_BASE_URL}/spaces/${spaceKey}/pages/${page.id}`;
			return {
				content: [
					{
						type: "text",
						text: `Page created successfully.\nTitle: ${page.title}\nID:    ${page.id}\nURL:   ${url}`,
					},
				],
			};
		} catch (err) {
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
	},
);

// ── Tool: confluence_update_page ──────────────────────────────────────────────

server.registerTool(
	"confluence_update_page",
	{
		description: [
			"Update the title and/or body of an existing Confluence page.",
			"You MUST supply the current version number (retrieve it with confluence_get_page first).",
			"Body can be plain text or Confluence storage-format XHTML.",
		].join(" "),
		inputSchema: {
			pageId: z
				.string()
				.min(1)
				.describe("The numeric Confluence page ID to update"),
			title: z.string().min(1).describe("New (or unchanged) page title"),
			body: z
				.string()
				.describe("New page content (plain text or storage-format XHTML)"),
			version: z
				.number()
				.int()
				.min(1)
				.describe(
					"Current version number of the page. The API will increment it by 1.",
				),
		},
	},
	async ({ pageId, title, body, version }) => {
		try {
			// We need the space key to build a useful URL; fetch it from the existing page.
			const existing = await confluenceGet(`/wiki/rest/api/content/${pageId}`, {
				expand: "space",
			});
			const spaceKey = existing.space?.key ?? "";
			const storageBody = toStorageFormat(body);

			const payload = {
				type: "page",
				title,
				version: { number: version + 1 },
				body: {
					storage: {
						value: storageBody,
						representation: "storage",
					},
				},
			};

			const page = await confluencePut(
				`/wiki/rest/api/content/${pageId}`,
				payload,
			);

			const url = `${CONFLUENCE_BASE_URL}/spaces/${spaceKey}/pages/${pageId}`;
			return {
				content: [
					{
						type: "text",
						text: `Page updated successfully.\nTitle:   ${page.title}\nID:      ${page.id}\nVersion: ${page.version?.number}\nURL:     ${url}`,
					},
				],
			};
		} catch (err) {
			return { isError: true, content: [{ type: "text", text: err.message }] };
		}
	},
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
