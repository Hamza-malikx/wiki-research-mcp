"use client";

import { FormEvent, useState } from "react";

interface ResearchResponse {
  topic: string;
  answer: string;
}

interface ActivityEvent {
  type: "status" | "log" | "progress";
  message: string;
  level?: string;
  progress?: number;
}

type ResearchStreamEvent =
  | ActivityEvent
  | {
      type: "result";
      topic: string;
      answer: string;
    }
  | {
      type: "error";
      message: string;
    };

export default function Home() {
  const [topic, setTopic] = useState("");
  const [result, setResult] =
    useState<ResearchResponse | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanTopic = topic.trim();

    if (cleanTopic.length < 2) {
      setError("Please enter a research topic.");
      return;
    }

    setError("");
    setResult(null);
    setActivity([]);
    setProgress(0);
    setIsLoading(true);

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          topic: cleanTopic,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string;
        };

        throw new Error(data.error ?? "Research failed.");
      }

      if (!response.body) {
        throw new Error(
          "The browser could not read the response stream.",
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let receivedResult = false;

      function handleStreamEvent(
        streamEvent: ResearchStreamEvent,
      ) {
        if (
          streamEvent.type === "status" ||
          streamEvent.type === "log" ||
          streamEvent.type === "progress"
        ) {
          setActivity((current) => [
            ...current,
            streamEvent,
          ]);

          if (
            streamEvent.type === "progress" &&
            streamEvent.progress !== undefined
          ) {
            setProgress(streamEvent.progress);
          }

          return;
        }

        if (streamEvent.type === "result") {
          receivedResult = true;
          setProgress(100);

          setResult({
            topic: streamEvent.topic,
            answer: streamEvent.answer,
          });

          return;
        }

        throw new Error(streamEvent.message);
      }

      function processLine(line: string) {
        const cleanLine = line.trim();

        if (!cleanLine) {
          return;
        }

        handleStreamEvent(
          JSON.parse(cleanLine) as ResearchStreamEvent,
        );
      }

      while (true) {
        const { done, value } = await reader.read();

        buffer += decoder.decode(value, {
          stream: !done,
        });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          processLine(line);
        }

        if (done) {
          break;
        }
      }

      processLine(buffer);

      if (!receivedResult) {
        throw new Error(
          "The research stream ended without a result.",
        );
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-5 py-16 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <header className="mb-12">
          <p className="mb-4 font-mono text-sm uppercase tracking-[0.25em] text-lime-300">
            MCP Research Assistant
          </p>

          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">
            Research a topic with Claude and Wikipedia
          </h1>

          <p className="mt-5 max-w-xl text-base leading-7 text-neutral-400">
            Claude selects an MCP tool, the MCP server researches
            Wikipedia, and the results are turned into a sourced
            report.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4"
        >
          <label
            htmlFor="topic"
            className="mb-3 block text-sm text-neutral-300"
          >
            Research topic
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="topic"
              value={topic}
              onChange={(event) =>
                setTopic(event.target.value)
              }
              placeholder="For example: quantum computing"
              maxLength={200}
              disabled={isLoading}
              className="min-w-0 flex-1 rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 outline-none transition focus:border-lime-300 disabled:opacity-60"
            />

            <button
              type="submit"
              disabled={isLoading}
              className="rounded-xl bg-lime-300 px-6 py-3 font-medium text-neutral-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? "Researching..." : "Research"}
            </button>
          </div>
        </form>

        {activity.length > 0 && (
          <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium text-neutral-200">
                Live activity
              </h2>

              <span className="font-mono text-xs text-lime-300">
                {progress}%
              </span>
            </div>

            <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-lime-300 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>

            <ol className="space-y-3">
              {activity.map((item, index) => (
                <li
                  key={`${index}-${item.message}`}
                  className="flex gap-3 text-sm text-neutral-400"
                >
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      item.type === "log"
                        ? "bg-sky-400"
                        : "bg-lime-300"
                    }`}
                  />

                  <span>
                    {item.message}

                    {item.type === "log" && item.level && (
                      <span className="ml-2 font-mono text-xs uppercase text-sky-400">
                        {item.level}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {error && (
          <p className="mt-5 rounded-xl border border-red-900 bg-red-950/40 p-4 text-red-300">
            {error}
          </p>
        )}

        {result && (
          <article className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6 sm:p-8">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-lime-300">
              Research complete
            </p>

            <h2 className="mb-6 text-2xl font-semibold">
              {result.topic}
            </h2>

            <div className="whitespace-pre-wrap text-base leading-8 text-neutral-300">
              {result.answer}
            </div>
          </article>
        )}
      </div>
    </main>
  );
}