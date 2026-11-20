import { Form } from "react-router";
import { findStories } from "../../src/reader/catalogue.server";
import { StoryGrid } from "../components/reader/stories";
import type { Route } from "./+types/search";

export function loader({ request }: Route.LoaderArgs) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 120);
  return { query, stories: query ? findStories({ query }) : [] };
}

export default function Search({ loaderData: { query, stories } }: Route.ComponentProps) {
  return (
    <main id="main-content" className="container reader-page" tabIndex={-1}>
      <title>Search | GeoLens AI</title>
      <div className="page-intro"><h1>Search</h1></div>
      <Form method="get" role="search" className="search-form" key={query}>
        <label htmlFor="reader-search">Search stories</label>
        <div className="button-row">
          <input id="reader-search" name="q" type="search" placeholder="Search by topic, place or headline" defaultValue={query} maxLength={120} />
          <button type="submit" className="button">Search</button>
        </div>
      </Form>
      {query ? (
        <>
          <p className="results-count" role="status">{stories.length} {stories.length === 1 ? "result" : "results"} for “{query}”</p>
          <StoryGrid stories={stories} />
        </>
      ) : <p className="empty-state">Enter a headline, topic or place to search the synthetic catalogue.</p>}
    </main>
  );
}
