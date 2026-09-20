import "server-only";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface ResearchUpdate {
  type: "status" | "log" | "progress";
  message: string;
  level?: string;
  progress?: number;
}

type UpdateHandler = (update: ResearchUpdate) => void;

function readableLogData(data: unknown) {
  if (typeof data === "string") {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return "MCP server sent a log update.";
  }
}

export async function runResearch(
  topic: string,
  onUpdate: UpdateHandler = () => {},
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing.");
  }

  const anthropic = new Anthropic({ apiKey });

  const researchOutputPath = path.resolve(
    process.cwd(),
    "../../research-output",
  );

  const mcpClient = new Client(
    {
      name: "wiki-research-next-host",
      version: "0.1.0",
    },
    {
      capabilities: {
        roots: {
          listChanged: false,
        },
      },
    },
  );
  mcpClient.setRequestHandler("roots/list", async () => {
    await mkdir(researchOutputPath, {
      recursive: true,
    });

    return {
      roots: [
        {
          uri: pathToFileURL(researchOutputPath).href,
          name: "Research Output",
        },
      ],
    };
  });
  mcpClient.setNotificationHandler("notifications/message", (notification) => {
    onUpdate({
      type: "log",
      level: notification.params.level,
      message: readableLogData(notification.params.data),
    });
  });

  // Next.js runs from apps/web, so we locate the MCP server from there.
  const serverPath = path.resolve(
    process.cwd(),
    "../../packages/wiki-mcp-server/src/index.ts",
  );

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
  });

  let connected = false;

  try {
    onUpdate({
      type: "status",
      message: "Connecting to the Wikipedia MCP server",
    });
    await mcpClient.connect(transport);
    connected = true;
    await mcpClient.setLoggingLevel("info");

    onUpdate({
      type: "status",
      message: "Discovering available MCP tools",
    });

    // Discover the tools provided by our MCP server.
    const { tools: mcpTools } = await mcpClient.listTools();

    // Convert MCP tools into Claude tool definitions.
    const claudeTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
    }));

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Research "${topic}" using the available tool. Explain it clearly and include the source links.`,
      },
    ];

    for (let turn = 0; turn < 5; turn++) {
      onUpdate({
        type: "status",
        message:
          turn === 0
            ? "Asking Claude to plan the research"
            : "Asking Claude to review the tool results",
      });
      const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
        max_tokens: 1800,
        system:
          "You are a concise research assistant. Use the available research tool, base your answer on its results, and include source links.",
        tools: claudeTools,
        messages,
      });

      messages.push({
        role: "assistant",
        content: response.content,
      });

      const toolCalls = response.content.filter(
        (block) => block.type === "tool_use",
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
        onUpdate({
          type: "status",
          message: "Research complete",
        });
        return answer;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolCalls) {
        onUpdate({
          type: "status",
          message: `Claude selected the ${toolCall.name} tool`,
        });
        const result = await mcpClient.callTool(
          {
            name: toolCall.name,
            arguments: toolCall.input as Record<string, unknown>,
          },
          {
            onprogress: ({ progress, total, message }) => {
              const percentage = total
                ? Math.round((progress / total) * 100)
                : undefined;

              onUpdate({
                type: "progress",
                progress: percentage,
                message: message ?? "MCP tool is working",
              });
            },
            resetTimeoutOnProgress: true,
          },
        );

        const resultText = result.content
          .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block),
          )
          .join("\n");

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: resultText,
          is_error: Boolean(result.isError),
        });
        onUpdate({
          type: "status",
          message: "Tool results received; preparing the final answer",
        });
      }

      messages.push({
        role: "user",
        content: toolResults,
      });
    }

    throw new Error("Maximum tool-call turns reached.");
  } finally {
    if (connected) {
      await mcpClient.close();
    }
  }
}
