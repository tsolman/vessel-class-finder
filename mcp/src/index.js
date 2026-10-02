#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig, lookupVessels, lookupVesselDemo, checkUsage, ToolError } from './client.js';

const STATUS_HELP =
  'Status meanings: Delivered, Reinstated and Reassigned = vessel is in class (in_class true); ' +
  'Suspended = class temporarily invalid; Withdrawn = no longer classed (in_class false for both).';

function wrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `Unexpected error: ${err?.message ?? err}`;
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };
}

export function createServer(config = getConfig()) {
  const server = new McpServer({ name: 'vessel-class-finder', version: '0.1.0' });

  server.registerTool(
    'lookup_vessels',
    {
      title: 'Look up vessel class status (batch)',
      description:
        'Look up the IACS classification society and class status of one or many ships by IMO number (1-100 per call). ' +
        "Use this whenever the user asks whether a ship is in class, which class society (ABS, DNV, Lloyd's Register, ClassNK, Bureau Veritas, etc.) classes it, or to screen a fleet or list of IMOs for suspended or withdrawn class. " +
        'Returns per vessel: imo, vessel_name, class (society code), society (full name), status, in_class (boolean), date_of_survey, date_of_next_survey, date_of_latest_status, reason_for_status. ' +
        STATUS_HELP +
        ' IMOs missing from IACS data are listed in not_found: that means the ship is not IACS-classed or the IMO is wrong. ' +
        'Each unique IMO counts as one lookup against the monthly quota (duplicates are removed). Requires VESSEL_CLASS_FINDER_API_KEY; for a single ship without a key use lookup_vessel_demo. ' +
        'Data is refreshed weekly from IACS and is not a substitute for class certificates.',
      inputSchema: {
        imos: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .max(100)
          .describe('IMO numbers, 1-100 items, each up to 7 digits (e.g. "9321483").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ imos }) => lookupVessels(config, imos))
  );

  server.registerTool(
    'lookup_vessel_demo',
    {
      title: 'Look up a single vessel (no API key)',
      description:
        'Look up the IACS class society and status of ONE ship by its 7-digit IMO number, without needing an API key. ' +
        'Use for quick single-ship questions or when no API key is configured. Rate limited to 10 requests per hour per IP; for several ships or regular use, get a free key at https://vesselclassfinder.com/#signup and use lookup_vessels. ' +
        STATUS_HELP +
        ' If the IMO is not found, the ship is not IACS-classed or the IMO is wrong.',
      inputSchema: {
        imo: z.union([z.string(), z.number()]).describe('A single 7-digit IMO number, e.g. "9321483".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ imo }) => lookupVesselDemo(config, imo))
  );

  server.registerTool(
    'check_usage',
    {
      title: 'Check API usage',
      description:
        "Show the current month's Vessel Class Finder API usage for the configured key: plan, lookups used, monthly limit and remaining. " +
        'Use before a large batch lookup, or when a lookup fails with a limit error. Requires VESSEL_CLASS_FINDER_API_KEY.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(() => checkUsage(config))
  );

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
