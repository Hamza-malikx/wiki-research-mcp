import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error(
    "ANTHROPIC_API_KEY is missing. Add it to packages/wiki-mcp-server/.env",
  );
}

const anthropic = new Anthropic({ apiKey });

const mcpClient = new Client({
  name: "wiki-research-claude-host",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/index.ts"],
});

const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

const question =
  process.argv.slice(2).join(" ") ||
  "Research the Model Context Protocol and explain why it is useful.";
console.log("question", question);
async function runResearch() {
  try {
    console.log("Connecting to the MCP server...");

    await mcpClient.connect(transport);

    // Discover tools from the MCP server
    const { tools: mcpTools } = await mcpClient.listTools();

    // Convert MCP tool definitions into Claude tool definitions
    const claudeTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
    }));

    console.log(`Giving Claude ${claudeTools.length} MCP tool(s)...\n`);

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: question,
      },
    ];

    // Limit the loop so the model cannot call tools forever
    for (let turn = 0; turn < 5; turn++) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1500,

        system: [
          "You are a concise research assistant.",
          "Use the available research tool for research questions.",
          "Base your answer on the tool results.",
          "Include the provided source links in the final answer.",
        ].join(" "),

        tools: claudeTools,
        messages,
      });

      // Save Claude's response in the conversation
      messages.push({
        role: "assistant",
        content: response.content,
      });

      const toolCalls = response.content.filter(
        (block) => block.type === "tool_use",
      );

      // No tool call means Claude has produced the final response
      if (toolCalls.length === 0) {
        const finalAnswer = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");

        console.log("Final answer:\n");
        console.log(finalAnswer);

        return;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolCalls) {
        console.log(`Claude requested: ${toolCall.name}`);
        console.log("Arguments:", toolCall.input);

        // Execute Claude's request through MCP
        const result = await mcpClient.callTool({
          name: toolCall.name,
          arguments: toolCall.input as Record<string, unknown>,
        });

        const resultText = result.content
          .map((block) => {
            if (block.type === "text") {
              return block.text;
            }

            return JSON.stringify(block);
          })
          .join("\n");

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: resultText,
          is_error: Boolean(result.isError),
        });
      }

      // Return MCP results to Claude
      messages.push({
        role: "user",
        content: toolResults,
      });
    }

    throw new Error("Maximum tool-call turns reached.");
  } finally {
    await mcpClient.close();
  }
}

runResearch().catch((error) => {
  console.error("Research failed:", error);
  process.exitCode = 1;
});
