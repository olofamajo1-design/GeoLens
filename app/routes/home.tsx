import { Link } from "react-router";
import { coverage, storyCards } from "../../src/reader/catalogue.server";
import { formatDate, storyPath } from "../../src/reader/presentation";
import { StoryGrid } from "../components/reader/stories";
import type { Route } from "./+types/home";

export function loader() {
  const [lead] = storyCards(["lagos-waterfront"]);
  return {
    lead,
    trending: storyCards(["west-africa-ports", "sahel-solar-grid", "diplomacy-table", "railway-age"]),
    coverage: coverage.map((group) => ({
      title: group.title,
      section: "section" in group ? group.section : null,
      stories: storyCards(group.slugs),
    })),
  };
}

export default function Home({ loaderData: { lead, trending, coverage } }: Route.ComponentProps) {
  return (
    <main id="main-content" className="container home" tabIndex={-1}>
      <title>GeoLens AI | Beyond the headlines</title>
      <h1 className="sr-only">GeoLens AI news and intelligence</h1>
      <div className="breaking">
        <strong><span aria-hidden="true">●</span> Breaking News</strong>
        <Link to={storyPath(lead.slug)}>{lead.title}<span aria-hidden="true"> →</span></Link>
      </div>

      <div className="top-stories">
        <article className="lead-story">
          <img src={"/images/" + lead.image + ".webp"} alt={lead.alt} fetchPriority="high" width="850" height="510" />
          <div className="lead-copy">
            <p className="eyebrow lead-kicker">Nigeria <span>·</span> {lead.type}</p>
            <h2><Link to={storyPath(lead.slug)}>{lead.title}</Link></h2>
            <p>{lead.summary}</p>
            <Link className="lead-read" to={storyPath(lead.slug)}>Read the story <span aria-hidden="true">→</span></Link>
          </div>
        </article>
        <aside className="trending" aria-labelledby="trending-heading">
          <h2 id="trending-heading">Trending Stories</h2>
          <ol>
            {trending.map((story, index) => (
              <li key={story.slug}>
                <span aria-hidden="true" className="trend-index">{String(index + 1).padStart(2, "0")}</span>
                <Link to={storyPath(story.slug)}>
                  <span className="eyebrow">{story.section} <span>·</span> {story.type}</span>
                  <strong>{story.title}</strong>
                  <time dateTime={story.published}>{formatDate(story.published)}</time>
                </Link>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      {coverage.map((group) => (
        <section key={group.title} className="coverage-section" aria-label={group.title}>
          <div className="section-heading">
            <h2>{group.title}</h2>
            {group.section && <Link to={"/section/" + group.section}>View section <span aria-hidden="true">→</span></Link>}
          </div>
          <StoryGrid stories={group.stories} />
        </section>
      ))}
    </main>
  );
}
