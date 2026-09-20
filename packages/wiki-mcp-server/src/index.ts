import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

interface WikipediaPage {
  pageid: number;
  title: string;
  extract?: string;
  fullurl?: string;
}

interface WikipediaResponse {
  query?: {
    pages?: WikipediaPage[];
  };
}

async function researchWikipedia(topic: string, limit: number) {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: topic,
    gsrlimit: String(limit),
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await fetch(`${WIKIPEDIA_API}?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WikiResearchMCP/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as WikipediaResponse;
  const pages = data.query?.pages ?? [];

  return pages.map((page) => ({
    title: page.title,
    summary:
      page.extract?.slice(0, 1800) ?? "Wikipedia did not return a summary.",
    url: page.fullurl ?? `https://en.wikipedia.org/?curid=${page.pageid}`,
  }));
}

function createServer() {
  const server = new McpServer(
    {
      name: "wikipedia-research-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "research_wikipedia",
    {
      title: "Research Wikipedia",
      description:
        "Search Wikipedia for a topic and return relevant article summaries with source links.",

      inputSchema: z.object({
        topic: z
          .string()
          .min(2)
          .max(120)
          .describe("The topic that should be researched"),

        limit: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Number of Wikipedia articles to return"),
      }),
    },
    async ({ topic, limit }, context) => {
      const progressToken = context.mcpReq._meta?.progressToken;

      async function reportProgress(progress: number, message: string) {
        if (progressToken === undefined) {
          return;
        }

        await context.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            total: 100,
            message,
          },
        });
      }
      try {
        await context.mcpReq.log(
          "info",
          { topic, limit },
          "wikipedia-research",
        );

        await reportProgress(10, "Preparing Wikipedia search");
        await reportProgress(35, "Searching Wikipedia");
        const articles = await researchWikipedia(topic, limit);
        await reportProgress(75, `Found ${articles.length} relevant articles`);

        if (articles.length === 0) {
          await reportProgress(100, "No matching articles found");
          return {
            content: [
              {
                type: "text",
                text: `No Wikipedia articles were found for "${topic}".`,
              },
            ],
          };
        }

        const result = {
          topic,
          source: "Wikipedia",
          articles,
        };
        await context.mcpReq.log(
          "info",
          { articleCount: articles.length },
          "wikipedia-research",
        );

        await reportProgress(100, "Wikipedia research complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown research error";
        await context.mcpReq.log("error", { message }, "wikipedia-research");
        await reportProgress(100, `Wikipedia research failed: ${message}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Wikipedia research failed: ${message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

void serveStdio(createServer);

console.error("Wikipedia MCP server is running on stdio");
