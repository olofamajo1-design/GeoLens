import { Form } from "react-router";
import { contentTypes, findStories, sections, type Section } from "../../src/reader/catalogue.server";
import { StoryGrid } from "../components/reader/stories";
import type { Route } from "./+types/section";

export function loader({ params, request }: Route.LoaderArgs) {
  const section = params.section as Section;
  if (!Object.hasOwn(sections, section)) throw new Response("Section unavailable", { status: 404 });
  const requestedType = new URL(request.url).searchParams.get("type");
  const type = contentTypes.find((option) => option === requestedType);
  return { label: sections[section], type, contentTypes, stories: findStories({ section, type }) };
}

export default function SectionPage({ loaderData }: Route.ComponentProps) {
  const { label, stories, contentTypes, type } = loaderData;
  return (
    <main id="main-content" className="container reader-page" tabIndex={-1}>
      <title>{`${label} | GeoLens AI`}</title>
      <div className="page-intro"><h1>{label}</h1></div>
      <Form method="get" className="filter-form" key={type ?? "all"}>
        <label htmlFor="content-type">Content type</label>
        <select id="content-type" name="type" defaultValue={type ?? ""}>
          <option value="">All types</option>
          {contentTypes.map((option) => <option key={option}>{option}</option>)}
        </select>
        <button type="submit" className="button">Apply filter</button>
      </Form>
      <StoryGrid stories={stories} />
    </main>
  );
}
