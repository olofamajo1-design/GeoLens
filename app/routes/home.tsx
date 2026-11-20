import { runAgentTask } from "../../src/newsroom/contracts";
import { agents } from "../../src/newsroom/registry";
import { syntheticProvider } from "../../src/providers/synthetic.server";
import type { Route } from "./+types/home";

export async function loader() {
  return runAgentTask(syntheticProvider, {
    schemaVersion: 1,
    storyId: "fixture-story-001",
    taskId: "fixture-task-001",
    agentId: "GL-AGENT-004",
    attempt: 1,
    topic: "Fictional Nigerian regional briefing",
  });
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <header>
        <p className="brand">GeoLens AI</p>
        <h1>Newsroom foundation</h1>
      </header>
      <section aria-labelledby="demo">
        <h2 id="demo">Synthetic preview</h2>
        <p>{loaderData.summary}</p>
        <dl>
          <dt>Fixture role</dt>
          <dd>{agents[loaderData.agentId]}</dd>
          <dt>Evidence</dt>
          <dd>{loaderData.evidence[0]?.description}</dd>
        </dl>
      </section>
      <section aria-labelledby="roster">
        <h2 id="roster">Newsroom roster</h2>
        <ul>
          {Object.entries(agents).map(([id, name]) => (
            <li key={id}><code>{id}</code><span>{name}</span></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
