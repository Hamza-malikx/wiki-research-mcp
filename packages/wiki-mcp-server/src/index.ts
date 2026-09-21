import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  server.registerTool(
    "save_research_report",
    {
      title: "Save Research Report",
      description:
        "Save a completed Markdown research report inside a client-approved MCP root.",

      inputSchema: z.object({
        title: z
          .string()
          .min(2)
          .max(120)
          .describe("Title used for the report heading and filename"),

        report: z
          .string()
          .min(1)
          .max(20_000)
          .describe("The complete research report in Markdown"),
      }),
    },

    async ({ title, report }, context) => {
      try {
        // Server asks the client which filesystem roots are allowed.
        const { roots } = await server.server.listRoots();

        const approvedRoot =
          roots.find((root) => root.name === "Research Output") ?? roots[0];

        if (!approvedRoot) {
          throw new Error("The client did not provide an approved root.");
        }

        const rootUrl = new URL(approvedRoot.uri);

        if (rootUrl.protocol !== "file:") {
          throw new Error("Only file-based roots are supported.");
        }

        const rootPath = path.resolve(fileURLToPath(rootUrl));

        // Generate the filename ourselves instead of accepting a path
        // from Claude.
        const safeTitle =
          title
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "research-report";

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

        const filename = `${safeTitle}-${timestamp}.md`;

        const filePath = path.resolve(rootPath, filename);

        // Confirm that the generated path remains inside the root.
        const relativePath = path.relative(rootPath, filePath);

        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
          throw new Error("The report path escaped the approved root.");
        }

        await mkdir(rootPath, {
          recursive: true,
        });

        const markdown = report.trimStart().startsWith("#")
          ? report
          : `# ${title}\n\n${report}`;

        await writeFile(filePath, markdown, {
          encoding: "utf8",

          // Never silently overwrite an existing report.
          flag: "wx",
        });

        const fileUri = pathToFileURL(filePath).href;

        await context.mcpReq.log(
          "info",
          {
            filename,
            root: approvedRoot.name,
          },
          "research-output",
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                saved: true,
                filename,
                uri: fileUri,
              }),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown save error";

        await context.mcpReq.log("error", { message }, "research-output");

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not save the research report: ${message}`,
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
