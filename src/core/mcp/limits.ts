/**
 * Time limits of starting an MCP server, shared by the client, the orchestrator and the error hints so that the
 * number in a message is the number in effect.
 */

/**
 * How long a server has to answer `initialize` (`startTimeoutMs` overrides it per server). Claude Code gives a server
 * 30 s to connect. 20 s was too tight on a PC that is starting a dozen servers at once: `uvx mcp-atlassian` alone
 * takes 18-21 s cold, and the same servers that answer in 3-12 s on their own went past 20 s inside the app.
 */
export const DEFAULT_START_TIMEOUT_MS = 30_000

/** A server that answered `initialize` is alive: each listing that follows gets at least this long, whatever is left of the start budget. */
export const MIN_LISTING_TIMEOUT_MS = 10_000
