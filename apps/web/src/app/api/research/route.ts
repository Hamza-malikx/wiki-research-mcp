import { runResearch, type ResearchUpdate } from "@/lib/run-research";

export const runtime = "nodejs";

type ResearchStreamEvent =
  | ResearchUpdate
  | {
      type: "result";
      topic: string;
      answer: string;
    }
  | {
      type: "error";
      message: string;
    };

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The request body must be valid JSON." },
      { status: 400 },
    );
  }

  const topic =
    typeof body === "object" &&
    body !== null &&
    "topic" in body &&
    typeof body.topic === "string"
      ? body.topic.trim()
      : "";

  if (topic.length < 2 || topic.length > 200) {
    return Response.json(
      {
        error: "The topic must contain between 2 and 200 characters.",
      },
      {
        status: 400,
      },
    );
  }

  const acceptsStream = request.headers
    .get("accept")
    ?.includes("application/x-ndjson");

  // Keep normal JSON responses working for non-streaming clients.
  if (!acceptsStream) {
    try {
      const answer = await runResearch(topic);

      return Response.json({
        topic,
        answer,
      });
    } catch (error) {
      console.error("Research API error:", error);

      return Response.json(
        {
          error: "The research request failed. Please try again.",
        },
        {
          status: 500,
        },
      );
    }
  }

  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ResearchStreamEvent) => {
        if (cancelled) {
          return;
        }

        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void (async () => {
        try {
          const answer = await runResearch(topic, send);

          send({
            type: "result",
            topic,
            answer,
          });
        } catch (error) {
          console.error("Research API error:", error);

          send({
            type: "error",
            message: "The research request failed. Please try again.",
          });
        } finally {
          if (!cancelled) {
            controller.close();
          }
        }
      })();
    },

    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
