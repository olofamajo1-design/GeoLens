import outputContract from "../schemas/newsroom-fixture-output.v1.json" with { type: "json" };
import discoveryOutput from "../schemas/newsroom/discovery-output.v1.json" with { type: "json" };
import historyOutput from "../schemas/newsroom/history-output.v1.json" with { type: "json" };
import verificationOutput from "../schemas/newsroom/verification-output.v1.json" with { type: "json" };
import analysisOutput from "../schemas/newsroom/analysis-output.v1.json" with { type: "json" };
import writingOutput from "../schemas/newsroom/writing-output.v1.json" with { type: "json" };
import visualOutput from "../schemas/newsroom/visual-output.v1.json" with { type: "json" };
import reverificationOutput from "../schemas/newsroom/reverification-output.v1.json" with { type: "json" };
import editorialOutput from "../schemas/newsroom/editorial-output.v1.json" with { type: "json" };
import { buildResearchResult } from "../newsroom/research/contracts.ts";
import { buildProductionResult } from "../newsroom/editorial/contracts.ts";
import type { ResearchInput } from "../newsroom/research/types";
import type { ProductionInput } from "../newsroom/editorial/types";
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
const researchSchemas = { discovery: discoveryOutput, history: historyOutput, verification: verificationOutput, analysis: analysisOutput };
const productionSchemas = { writing: writingOutput, visual: visualOutput, reverification: reverificationOutput, editorial: editorialOutput };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const fixtureResponse: Transport = async (body, signal) => {
  signal.throwIfAborted();
  const content = JSON.stringify(body.text.format.name === "geolens_fixture_result"
    ? { synthetic: true, disposition: "complete", summary: "Synthetic fixture task completed.", revisionStage: null }
    : body.text.format.name.startsWith("geolens_production_")
      ? buildProductionResult(JSON.parse(body.input[1].content) as ProductionInput)
      : buildResearchResult(JSON.parse(body.input[1].content) as ResearchInput));
  return {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
    usage: {
      input_tokens: Math.ceil(body.input.reduce((length, item) => length + item.content.length, 0) / 4),
      output_tokens: Math.ceil(content.length / 4),
    },
  };
};

// The transport runs in process using the validated fixture packet.
export function createOpenAIFixtureProvider(transport: Transport = fixtureResponse): FixtureProvider {
  return async ({ task, researchInput, productionInput, instructions, model, maxOutputTokens, signal }) => {
    const name = productionInput ? "geolens_production_" + productionInput.stage
      : researchInput ? "geolens_research_" + researchInput.stage : "geolens_fixture_result";
    const schema = productionInput ? productionSchemas[productionInput.stage]
      : researchInput ? researchSchemas[researchInput.stage] : structuredOutput;
    const response = await transport({
      model, store: false, max_output_tokens: maxOutputTokens,
      input: [{ role: "developer", content: instructions }, { role: "user", content: JSON.stringify(productionInput ?? researchInput ?? task) }],
      text: { format: { type: "json_schema", name, strict: true, schema } },
    }, signal);
    if (!record(response) || response.status !== "completed" || !Array.isArray(response.output)
      || response.output.length !== 1 || !record(response.usage)) throw new Error("fixture_provider_response");
    const [message] = response.output;
    if (!record(message) || message.type !== "message" || message.role !== "assistant"
      || !Array.isArray(message.content) || message.content.length !== 1) throw new Error("fixture_provider_message");
    const [content] = message.content;
    if (!record(content) || content.type !== "output_text" || typeof content.text !== "string"
      || content.text.length > (researchInput || productionInput ? 65_536 : 4096)) {
      throw new Error("fixture_provider_content");
    }
    return {
      output: JSON.parse(content.text) as unknown,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}
