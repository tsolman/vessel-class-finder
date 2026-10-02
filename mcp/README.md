# Vessel Class Finder MCP server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI assistants such as Claude Desktop, Claude Code and Cursor look up a ship's **IACS classification society and class status** by IMO number, using the [Vessel Class Finder](https://vesselclassfinder.com) API.

## Tools

| Tool | What it does | Needs API key |
| --- | --- | --- |
| `lookup_vessels` | Batch lookup of 1-100 IMOs. Returns society name, `in_class` flag, survey dates and status reason per ship, plus a list of IMOs not found in IACS data. | Yes |
| `lookup_vessel_demo` | Look up a single 7-digit IMO. Limited to 10 requests/hour per IP. | No |
| `check_usage` | Shows your plan, lookups used, monthly limit and remaining. | Yes |

Status meanings: **Delivered / Reinstated / Reassigned** = in class; **Suspended** = class temporarily invalid; **Withdrawn** = no longer classed.

Class society codes are expanded to names (NKK = ClassNK, BV = Bureau Veritas, ABS, NV = DNV, LRS = Lloyd's Register, RINA, CCS, KR, IRS, PRS, CRS, TLV = Türk Loydu).

## Get an API key

A free key (100 lookups/month) is available at <https://vesselclassfinder.com/#signup>. Without a key, only `lookup_vessel_demo` works.

## Install and configure

Requires Node.js 20 or newer. No install step: clients run it with `npx`.

Environment variables:

- `VESSEL_CLASS_FINDER_API_KEY`: your API key (required for `lookup_vessels` and `check_usage`)
- `VESSEL_CLASS_FINDER_API_URL`: optional API base URL override

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "vessel-class-finder": {
      "command": "npx",
      "args": ["-y", "vessel-class-finder-mcp"],
      "env": {
        "VESSEL_CLASS_FINDER_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add vessel-class-finder --env VESSEL_CLASS_FINDER_API_KEY=your-api-key -- npx -y vessel-class-finder-mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "vessel-class-finder": {
      "command": "npx",
      "args": ["-y", "vessel-class-finder-mcp"],
      "env": {
        "VESSEL_CLASS_FINDER_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Example prompts

- "Is IMO 9321483 in class?"
- "Which class society classes IMO 9321483, and when is its next survey?"
- "Check these 20 ships and list any that are suspended or withdrawn: ..."
- "How many lookups do I have left this month?"

## Limits and caveats

Free plan: 100 lookups/month (each unique IMO is one lookup; duplicates in a request are removed; IMOs not in IACS data are omitted from results and reported as not found). Demo tool: 10 requests/hour per IP. Data is refreshed weekly from IACS and is not a substitute for class certificates.

## Development

```bash
cd mcp
npm install
npm test
node src/index.js   # speaks MCP over stdio
```

## License

MIT
