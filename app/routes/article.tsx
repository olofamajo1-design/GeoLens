import { Link } from "react-router";
import { findStories, getStory, sections } from "../../src/reader/catalogue.server";
import { formatDate } from "../../src/reader/presentation";
import { ArticleActions } from "../components/reader/article-actions";
import { StoryGrid } from "../components/reader/stories";
import type { Route } from "./+types/article";

export function loader({ params }: Route.LoaderArgs) {
  const story = getStory(params.slug);
  if (!story) throw new Response("Story unavailable", { status: 404 });
  const matching = findStories({ section: story.section }).filter((item) => item.slug !== story.slug);
  const additional = findStories().filter((item) => item.slug !== story.slug && item.section !== story.section);
  return { story, section: sections[story.section], related: [...matching, ...additional].slice(0, 3) };
}

export default function Article({ loaderData: { story, section, related } }: Route.ComponentProps) {
  return (
    <main id="main-content" className="container reader-page article-page" tabIndex={-1}>
      <title>{`${story.title} | GeoLens AI`}</title>
      <article>
        <header className="article-intro">
          <p className="eyebrow">
            <Link to={"/section/" + story.section}>{section}</Link> <span>·</span> {story.type}
          </p>
          <h1>{story.title}</h1>
          <p className="article-summary">{story.summary}</p>
          <div className="article-meta">
            <span>{story.location}</span>
            <span>Published <time dateTime={story.published}>{formatDate(story.published)}</time></span>
            {story.updated && <span>Updated <time dateTime={story.updated}>{formatDate(story.updated)}</time></span>}
          </div>
          <ArticleActions key={story.slug} slug={story.slug} title={story.title} />
        </header>
        <figure className="article-visual">
          <img src={"/images/" + story.image + ".webp"} alt={story.alt} width="850" height="510" fetchPriority="high" />
          <figcaption>AI-generated editorial illustration · Synthetic preview</figcaption>
        </figure>
        <div className="article-copy">
          <p className="verification"><strong>Verification status</strong> · Synthetic preview. This article makes no claim of real-world verification.</p>
          {story.type === "Forecast" && <p className="verification"><strong>Forecast uncertainty</strong> · This scenario depends on illustrative assumptions. Outcomes could differ substantially.</p>}
          <section className="quick-brief">
            <h2>Quick Brief</h2>
            <ul>{story.quickBrief.map((point) => <li key={point}>{point}</li>)}</ul>
          </section>
          <section>
            <h2>Deep Dive</h2>
            {story.deepDive.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
          <section>
            <h2>Historical background</h2>
            <p>{story.background}</p>
          </section>
          <section>
            <h2>Timeline</h2>
            <div className="timeline">
              {story.timeline.map((entry) => (
                <details key={entry.date}>
                  <summary><time dateTime={entry.date}>{formatDate(entry.date)}</time> {entry.label}</summary>
                  <p>{entry.detail}</p>
                </details>
              ))}
            </div>
          </section>
          <section>
            <h2>Source references</h2>
            <p>Illustrative references for this synthetic article.</p>
            <ol>{story.sources.map((source) => <li key={source}>{source}</li>)}</ol>
          </section>
        </div>
      </article>
      <section className="coverage-section" aria-label="Related stories">
        <div className="section-heading"><h2>Related stories</h2></div>
        <StoryGrid stories={related} />
      </section>
    </main>
  );
}
