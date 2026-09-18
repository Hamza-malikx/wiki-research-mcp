import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({
  name: "wiki-research-test-client",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/index.ts"],
});

async function main() {
  try {
    console.log("Connecting to the MCP server...");

    await client.connect(transport);

    console.log("Connected successfully.\n");

    // Ask the MCP server which tools it provides
    const { tools } = await client.listTools();

    console.log("Available tools:");

    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description}`);
    }

    console.log("\nCalling research_wikipedia...\n");

    // Call one of the discovered tools
    const result = await client.callTool({
      name: "research_wikipedia",
      arguments: {
        topic: "Model Context Protocol",
        limit: 3,
      },
    });

    for (const block of result.content) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  } catch (error) {
    console.error("MCP client failed:", error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
