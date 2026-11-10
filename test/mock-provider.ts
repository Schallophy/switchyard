import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9911);

const MODELS = [
  "qwen3.8-max-0902",
  "kimi-k3.1-pro",
  "qwen3.8-27b",
  "kimi-k3",
  "qwen3.8-flash",
  "deepseek-v3.2",
  "qwen3.8-coder",
  "glm-5",
  "minimax-m2",
  "qwen3.8-vl",
  "qwen3.8-deep-research",
];

const RESPONSES_MODELS = new Set([
  "qwen3.8-max-0902",
  "kimi-k3.1-pro",
  "qwen3.8-27b",
  "qwen3.8-vl",
  "qwen3.8-deep-research",
]);

const RESPONSES_ONLY_MODELS = new Set(["qwen3.8-deep-research"]);

const BEHAVIOR: Record<string, "ok" | "quota" | "throttle" | "missing"> = {
  "qwen3.8-max-0902": "quota",
  "kimi-k3": "throttle",
  "deepseek-v3.2": "missing",
  "glm-5": "missing",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function completion(model: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `来自 ${model} 的模拟回复：请求已被网关正常转发。` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 26, completion_tokens: 18, total_tokens: 44 },
  };
}

function streamCompletion(model: string, res: ServerResponse): void {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const pieces = ["来自 ", model, " 的流式模拟回复：", "网关已经把请求", "转发成功。"];
  let index = 0;

  const tick = (): void => {
    if (index < pieces.length) {
      const delta = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(delta)}\n\n`);
      index += 1;
      setTimeout(tick, 90);
      return;
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  };

  tick();
}

function responsePayload(model: string, status: "in_progress" | "completed" = "completed"): Record<string, unknown> {
  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output:
      status === "completed"
        ? [
            {
              id: `msg_${Date.now()}`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: `来自 ${model} 的 Responses 模拟回复：请求已被网关正常转发。`, annotations: [] }],
            },
          ]
        : [],
    usage:
      status === "completed"
        ? { input_tokens: 31, output_tokens: 21, total_tokens: 52 }
        : null,
  };
}

function streamResponse(model: string, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const send = (type: string, data: Record<string, unknown>): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  send("response.created", { response: responsePayload(model, "in_progress") });

  const pieces = ["来自 ", model, " 的 Responses 流式回复：", "网关已经把请求", "转发成功。"];
  let index = 0;

  const tick = (): void => {
    if (index < pieces.length) {
      send("response.output_text.delta", {
        item_id: `msg_${Date.now()}`,
        output_index: 0,
        content_index: 0,
        delta: pieces[index],
      });
      index += 1;
      setTimeout(tick, 90);
      return;
    }
    send("response.output_text.done", { item_id: `msg_${Date.now()}`, output_index: 0, content_index: 0 });
    send("response.completed", { response: responsePayload(model, "completed") });
    res.end();
  };

  tick();
}

function behaviorFailure(model: string): { status: number; body: Record<string, unknown> } | null {
  const behavior = BEHAVIOR[model] ?? "ok";
  if (behavior === "quota") {
    return {
      status: 403,
      body: {
        error: {
          code: "AllocationQuota.FreeTierOnly",
          message: "The free tier resource of this model has been exhausted.",
        },
      },
    };
  }
  if (behavior === "throttle") {
    return {
      status: 429,
      body: { error: { code: "Throttling.AllocationQuota", message: "Requests rate limit exceeded." } },
    };
  }
  if (behavior === "missing") {
    return {
      status: 404,
      body: { error: { code: "ModelNotFound", message: `Model ${model} does not exist.` } },
    };
  }
  return null;
}

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://mock");

    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      sendJson(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "mock" })) });
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const body = await readJson(req);
      const model = typeof body.model === "string" ? body.model : "";

      if (RESPONSES_ONLY_MODELS.has(model)) {
        sendJson(res, 400, {
          error: { code: "UnsupportedEndpoint", message: `Model ${model} does not support the chat completions endpoint.` },
        });
        return;
      }

      const failure = behaviorFailure(model);
      if (failure) {
        sendJson(res, failure.status, failure.body);
        return;
      }

      if (body.stream === true) {
        streamCompletion(model, res);
        return;
      }
      sendJson(res, 200, completion(model));
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/responses")) {
      const body = await readJson(req);
      const model = typeof body.model === "string" ? body.model : "";

      if (!RESPONSES_MODELS.has(model)) {
        sendJson(res, 400, {
          error: { code: "UnsupportedEndpoint", message: `Model ${model} does not support the responses endpoint.` },
        });
        return;
      }

      const failure = behaviorFailure(model);
      if (failure) {
        sendJson(res, failure.status, failure.body);
        return;
      }

      if (body.stream === true) {
        streamResponse(model, res);
        return;
      }
      sendJson(res, 200, responsePayload(model));
      return;
    }

    sendJson(res, 404, { error: { code: "NotFound", message: `${req.method} ${url.pathname}` } });
  })();
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock provider listening on http://127.0.0.1:${PORT}/v1\n`);
});
