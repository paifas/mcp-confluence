# mcp-confluence

A minimal Node.js MCP server that connects **GitHub Copilot in VS Code** to **Confluence Cloud** via the REST API. No third-party Atlassian wrappers — every line is owned by you.

## Features

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `confluence_search`      | CQL full-text search across pages                |
| `confluence_get_page`    | Fetch a page's full content as plain text        |
| `confluence_list_spaces` | List all accessible spaces                       |
| `confluence_create_page` | Create a new child page under a parent           |
| `confluence_update_page` | Update the title and/or body of an existing page |

## Prerequisites

- Node.js 18+
- A Confluence Cloud instance
- An [Atlassian OAuth 2.0 (3LO) app](https://developer.atlassian.com/console/myapps/) with:
  - Callback URL: `http://localhost:8080/callback`
  - Scopes: `read:confluence-content.all`, `read:confluence-space.summary`, `write:confluence-content`

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure credentials

```sh
cp .env.example .env
```

Edit `.env`:

```
CONFLUENCE_CLIENT_ID=your-client-id
CONFLUENCE_CLIENT_SECRET=your-client-secret
CONFLUENCE_URL=https://your-org.atlassian.net/wiki
```

### 3. Authorise (one-time)

```sh
node auth.js
```

This opens your browser, completes the OAuth flow, and saves tokens to `~/.confluence-mcp/tokens.json` (permissions `600`). You only need to do this once — the server refreshes tokens automatically.

### 4. Add to VS Code

Open your MCP configuration (`Cmd+Shift+P` → **MCP: Open User Configuration**) and add:

```json
{
	"servers": {
		"confluence": {
			"type": "stdio",
			"command": "node",
			"args": ["/absolute/path/to/confluence-mcp/server.js"],
			"env": {
				"CONFLUENCE_CLIENT_ID": "your-client-id",
				"CONFLUENCE_CLIENT_SECRET": "your-client-secret",
				"CONFLUENCE_URL": "https://your-org.atlassian.net/wiki"
			}
		}
	}
}
```

Reload the VS Code window and the tools will appear in Copilot Chat.

## Usage examples

```
Search pages:          confluence_search("ancestor = 214728778")
Read a page:           confluence_get_page("214728778")
List spaces:           confluence_list_spaces()
Create a child page:   confluence_create_page(spaceKey="DPT", parentId="214728778", title="My Page", body="Hello world")
Update a page:         confluence_update_page(pageId="123456", title="Updated Title", body="New content", version=3)
```

> **Tip:** Always call `confluence_get_page` before `confluence_update_page` to get the current `version` number — the API requires it.

## Security

- Credentials are never stored in the repository.
- The token file (`~/.confluence-mcp/tokens.json`) lives outside the project and is created with mode `600`.
- `.env` is git-ignored.

## License

MIT
