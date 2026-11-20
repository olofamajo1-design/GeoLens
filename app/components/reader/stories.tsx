import { Link } from "react-router";
import type { StoryCardData } from "../../../src/reader/catalogue.server";
import { formatDate, storyPath } from "../../../src/reader/presentation";

export function StoryCard({ story }: { story: StoryCardData }) {
  return (
    <article className="story-card">
      <Link to={storyPath(story.slug)} className="story-card-link">
        <img src={"/images/" + story.image + ".webp"} alt={story.alt} loading="lazy" width="640" height="420" />
        <div className="story-card-content">
          <p className="eyebrow">{story.section} <span>·</span> {story.type}</p>
          <h3>{story.title}</h3>
          <p>{story.summary}</p>
          <time dateTime={story.published}>{formatDate(story.published)}</time>
        </div>
      </Link>
    </article>
  );
}

export function StoryGrid({ stories }: { stories: StoryCardData[] }) {
  if (stories.length === 0) return <p className="empty-state">No stories match these filters.</p>;
  return <div className="story-grid">{stories.map((story) => <StoryCard key={story.slug} story={story} />)}</div>;
}
