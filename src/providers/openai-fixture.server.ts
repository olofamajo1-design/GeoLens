import outputContract from "../schemas/newsroom-fixture-output.v1.json" with { type: "json" };
import type { FixtureProvider } from "../newsroom/execution";

type ProviderRequest = {
  model: string;
  input: { role: "developer" | "user"; content: string }[];
  max_output_tokens: number;
  store: false;
  text: { format: { type: "json_schema"; name: string; strict: true; schema: object } };
};

type Transport = (body: ProviderRequest, signal: AbortSignal) => Promise<unknown>;

const { $schema: _schema, $id: _id, ...structuredOutput } = outputContract;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const fixtureResponse: Transport = async (body, signal) => {
  signal.throwIfAborted();
  const content = JSON.stringify({
    synthetic: true, disposition: "complete", summary: "Synthetic fixture task completed.", revisionStage: null,
  });
  return {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
    usage: {
      input_tokens: Math.ceil(body.input.reduce((length, item) => length + item.content.length, 0) / 4),
      output_tokens: Math.ceil(content.length / 4),
    },
  };
};

// Stage 5A supplies only an in-process fixture transport. There is no endpoint or credential.
export function createOpenAIFixtureProvider(transport: Transport = fixtureResponse): FixtureProvider {
  return async ({ task, instructions, model, maxOutputTokens, signal }) => {
    const response = await transport({
      model, store: false, max_output_tokens: maxOutputTokens,
      input: [{ role: "developer", content: instructions }, { role: "user", content: JSON.stringify(task) }],
      text: { format: { type: "json_schema", name: "geolens_fixture_result", strict: true, schema: structuredOutput } },
    }, signal);
    if (!record(response) || response.status !== "completed" || !Array.isArray(response.output)
      || response.output.length !== 1 || !record(response.usage)) throw new Error("fixture_provider_response");
    const [message] = response.output;
    if (!record(message) || message.type !== "message" || message.role !== "assistant"
      || !Array.isArray(message.content) || message.content.length !== 1) throw new Error("fixture_provider_message");
    const [content] = message.content;
    if (!record(content) || content.type !== "output_text" || typeof content.text !== "string" || content.text.length > 4096) {
      throw new Error("fixture_provider_content");
    }
    return {
      output: JSON.parse(content.text) as unknown,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}
