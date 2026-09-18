import "server-only";

import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export async function runResearch(topic: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing.");
  }

  const anthropic = new Anthropic({ apiKey });

  const mcpClient = new Client({
    name: "wiki-research-next-host",
    version: "0.1.0"
  });

  // Next.js runs from apps/web, so we locate the MCP server from there.
  const serverPath = path.resolve(
    process.cwd(),
    "../../packages/wiki-mcp-server/src/index.ts"
  );

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath]
  });

  let connected = false;

  try {
    await mcpClient.connect(transport);
    connected = true;

    // Discover the tools provided by our MCP server.
    const { tools: mcpTools } = await mcpClient.listTools();

    // Convert MCP tools into Claude tool definitions.
    const claudeTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema:
        tool.inputSchema as Anthropic.Tool["input_schema"]
    }));

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Research "${topic}" using the available tool. Explain it clearly and include the source links.`
      }
    ];

    for (let turn = 0; turn < 5; turn++) {
      const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
        max_tokens: 1800,
        system:
          "You are a concise research assistant. Use the available research tool, base your answer on its results, and include source links.",
        tools: claudeTools,
        messages
      });

      messages.push({
        role: "assistant",
        content: response.content
      });

      const toolCalls = response.content.filter(
        (block) => block.type === "tool_use"
      );

      // No tool call means Claude has completed the answer.
      if (toolCalls.length === 0) {
        const answer = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");

        if (!answer) {
          throw new Error("Claude returned an empty response.");
        }

        return answer;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolCalls) {
        const result = await mcpClient.callTool({
          name: toolCall.name,
          arguments: toolCall.input as Record<string, unknown>
        });

        const resultText = result.content
          .map((block) =>
            block.type === "text"
              ? block.text
              : JSON.stringify(block)
          )
          .join("\n");

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: resultText,
          is_error: Boolean(result.isError)
        });
      }

      messages.push({
        role: "user",
        content: toolResults
      });
    }

    throw new Error("Maximum tool-call turns reached.");
  } finally {
    if (connected) {
      await mcpClient.close();
    }
  }
}