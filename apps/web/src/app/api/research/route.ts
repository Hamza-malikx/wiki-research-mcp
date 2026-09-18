import { runResearch } from "@/lib/run-research";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const topic =
      typeof body.topic === "string"
        ? body.topic.trim()
        : "";

    if (topic.length < 2 || topic.length > 200) {
      return Response.json(
        {
          error: "The topic must contain between 2 and 200 characters."
        },
        {
          status: 400
        }
      );
    }

    const answer = await runResearch(topic);

    return Response.json({
      topic,
      answer
    });
  } catch (error) {
    console.error("Research API error:", error);

    return Response.json(
      {
        error: "The research request failed. Please try again."
      },
      {
        status: 500
      }
    );
  }
}