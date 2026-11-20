export const sections = {
  nigeria: "Nigeria",
  africa: "Africa",
  world: "World",
  geopolitics: "Geopolitics",
  history: "History",
} as const;

export type Section = keyof typeof sections;
export const contentTypes = ["Reporting", "Analysis", "Forecast"] as const;
export type ContentType = (typeof contentTypes)[number];
export type Story = {
  slug: string;
  title: string;
  summary: string;
  type: ContentType;
  section: Section;
  location: string;
  image: string;
  alt: string;
  published: string;
  updated?: string;
  quickBrief: string[];
  deepDive: string[];
  background: string;
  timeline: { date: string; label: string; detail: string }[];
  sources: string[];
};

const publicStories: Story[] = [
  {
    slug: "lagos-waterfront",
    title: "Lagos looks to the water for its next chapter",
    summary: "A fictional waterfront plan brings transport, housing and flood resilience into the same conversation.",
    type: "Reporting", section: "nigeria", location: "Lagos, Nigeria",
    image: "lagos", alt: "Illustrative aerial view of the Lagos waterfront and bridges at dusk",
    published: "2026-11-20T07:00:00Z", updated: "2026-11-20T09:15:00Z",
    quickBrief: ["A fictional planning committee proposes to connect ferry routes with rail and bus services.", "The plan puts flood resilience and housing access alongside transport investment.", "Community consultation and funding would determine what moves forward."],
    deepDive: ["In this fictional scenario, the city’s planning committee puts the lagoon at the centre of a proposed transport and housing strategy. The proposal links ferry terminals to roads and rail stations and identifies low-lying areas that would need flood protection.", "The main trade-off is access. New connections could cut journey times for some residents, while rising land values could push others farther from work. The published proposal in this exercise does not settle which communities would benefit first."],
    background: "The lagoon has long shaped how Lagos trades, expands and moves. The scenario asks how that geography could inform new infrastructure and what planners would need to learn from residents before drawing up a final route.",
    timeline: [
      { date: "2026-11-03", label: "Planning brief circulated", detail: "A fictional planning committee outlines transport and flood-protection priorities." },
      { date: "2026-11-12", label: "Neighbourhood consultations begin", detail: "Fixture meeting notes record concern about fares and displacement." },
      { date: "2026-11-20", label: "Preliminary route map released", detail: "An illustrative map describes possible connections for further review." },
    ],
    sources: ["Fictional Lagos waterfront planning brief", "Synthetic neighbourhood consultation notes", "Illustrative transport and flood exposure map"],
  },
  {
    slug: "west-africa-ports",
    title: "The race to reshape West Africa’s ports",
    summary: "A synthetic trade scenario explores how better rail links could change where cargo moves.",
    type: "Analysis", section: "africa", location: "West Africa",
    image: "port", alt: "Illustrative West African container port with cranes and freight stacks",
    published: "2026-11-20T06:30:00Z",
    quickBrief: ["A fictional regional study compares port-to-rail connections.", "Border clearance and last-mile costs matter as much as harbour capacity."],
    deepDive: ["The exercise compares fictional freight routes that serve overlapping markets. Shorter port dwell times can make a route more attractive, but the gain can disappear when cargo waits at a border or on the road.", "The model treats the rail timetable and customs processing as linked constraints. It highlights where additional investment might have the largest effect under the stated assumptions."],
    background: "Regional ports connect coastal cities with inland markets. The scenario examines how that relationship changes when freight can move more cheaply by rail.",
    timeline: [{ date: "2026-11-18", label: "Illustrative route comparison completed", detail: "The scenario compares turnaround times across fictional corridors." }],
    sources: ["Synthetic West African freight model", "Fictional multimodal port infrastructure briefing"],
  },
  {
    slug: "sahel-solar-grid",
    title: "What a regional solar grid could mean for the Sahel",
    summary: "An illustrative outlook weighs cross-border power sharing against financing and transmission risks.",
    type: "Forecast", section: "africa", location: "Sahel",
    image: "solar", alt: "Illustrative solar panels stretching across an arid landscape",
    published: "2026-11-19T14:15:00Z",
    quickBrief: ["The scenario models shared transmission capacity and uneven electricity demand.", "Storage costs and cross-border agreements could change the result."],
    deepDive: ["The forecast exercise assumes that neighbouring grids can exchange excess generation during the day. In the scenario, trade reduces the need to build backup capacity in each individual system.", "A change in capital costs or delays along a transmission corridor alters the outcome. The estimates are conditional, and this exercise provides no probability of completion."],
    background: "Regional power sharing depends on interconnectors and agreements about dispatch, payment and reliability.",
    timeline: [{ date: "2026-11-19", label: "Assumptions set out", detail: "The fictional model specifies generation, demand and finance inputs." }],
    sources: ["Synthetic regional power-pool scenario", "Illustrative transmission assumptions"],
  },
  {
    slug: "diplomacy-table",
    title: "What smaller states bring to the negotiating table",
    summary: "A fictional diplomatic round illustrates how coalitions can influence a wider agreement.",
    type: "Analysis", section: "geopolitics", location: "International",
    image: "diplomacy", alt: "Illustrative delegates seated in an international assembly chamber",
    published: "2026-11-19T13:00:00Z",
    quickBrief: ["In this fictional round, a coalition puts a shared amendment on the agenda.", "The exercise shows how agenda timing can influence an agreement."],
    deepDive: ["The fictional coalition brings a narrowly scoped amendment to delegates from several larger negotiating groups. Rather than reopening the main text, it seeks agreement on a single reporting provision.", "The exercise traces the conditions that make this approach plausible, including advance coordination and an amendment that leaves room for compromise."],
    background: "International negotiations often move between formal sessions and smaller groups where delegates can test draft language.",
    timeline: [{ date: "2026-11-19", label: "Synthetic negotiating round opens", detail: "Delegations present their fictional amendments." }],
    sources: ["Fictional negotiation agenda", "Synthetic diplomatic process notes"],
  },
  {
    slug: "railway-age",
    title: "How the railway changed coastal West Africa",
    summary: "A historical teaching scenario examines the relationship between railway routes, trade and settlement.",
    type: "Analysis", section: "history", location: "West Africa",
    image: "rail", alt: "Illustrative archival-style photograph of a historic railway station and tracks",
    published: "2026-11-18T12:00:00Z",
    quickBrief: ["The illustrative archive follows a fictional rail corridor from coast to inland markets.", "The history exercise compares changes in trade with changes in where people settled."],
    deepDive: ["The teaching scenario follows a fictional corridor linking an inland market with the coast. Its archival illustrations show how a station could grow into a commercial centre as freight services expanded.", "The exercise uses a fictional oral history and trade ledger to illustrate how transport changes can benefit communities unevenly."],
    background: "Historical rail lines shaped trade and links between settlements. Understanding who invested in them and who used them helps explain their different local effects.",
    timeline: [{ date: "2026-11-18", label: "Teaching archive assembled", detail: "Synthetic maps, interview extracts and ledgers are grouped for the exercise." }],
    sources: ["Synthetic railway teaching archive", "Illustrative oral history transcript"],
  },
  {
    slug: "coastal-resilience",
    title: "The quiet work of protecting coastal cities",
    summary: "A synthetic coastal briefing compares approaches to wetlands, drainage and extreme rain.",
    type: "Reporting", section: "world", location: "Global coastlines",
    image: "coast", alt: "Illustrative aerial photograph of green coastal wetlands and waterways",
    published: "2026-11-19T09:00:00Z",
    quickBrief: ["The fictional briefing compares three approaches to coastal flood protection.", "Planners in the exercise identify maintenance and local land use as shared concerns."],
    deepDive: ["The fictional briefing tracks how urban teams might combine wetland restoration with drainage improvements. It examines different site conditions rather than recommending one standard design.", "The synthetic case notes distinguish short-term maintenance from long-term land-use decisions, showing how each affects flood risk over time."],
    background: "Coastal flood protection can combine natural features with engineered measures. Their effectiveness depends on local geography, maintenance and the ability to keep expanding infrastructure out of high-risk locations.",
    timeline: [{ date: "2026-11-19", label: "Synthetic coastal briefing issued", detail: "The fixture compares scenarios across fictional shoreline communities." }],
    sources: ["Synthetic coastal resilience briefing", "Fictional wetland and drainage case notes"],
  },
];

export const coverage = [
  { title: "Developing Stories", slugs: ["west-africa-ports", "sahel-solar-grid", "coastal-resilience"] },
  { title: "Editor’s Picks", slugs: ["diplomacy-table", "railway-age", "lagos-waterfront"] },
  { title: "Nigeria", section: "nigeria", slugs: ["lagos-waterfront"] },
  { title: "Africa", section: "africa", slugs: ["west-africa-ports", "sahel-solar-grid"] },
  { title: "World", section: "world", slugs: ["coastal-resilience"] },
  { title: "Featured intelligence reports", section: "geopolitics", slugs: ["diplomacy-table", "sahel-solar-grid"] },
  { title: "Historical explainers", section: "history", slugs: ["railway-age"] },
] as const;

export function getStory(slug: string) {
  return publicStories.find((story) => story.slug === slug);
}

export function storyCards(slugs: readonly string[]) {
  return slugs.flatMap((slug) => {
    const story = getStory(slug);
    return story ? [toCard(story)] : [];
  });
}

function toCard({ slug, title, summary, type, section, image, alt, published }: Story) {
  return { slug, title, summary, type, section, image, alt, published };
}

export type StoryCardData = ReturnType<typeof toCard>;

export function findStories({ query = "", section, type }: {
  query?: string;
  section?: Section;
  type?: ContentType;
} = {}) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return publicStories.filter((story) => {
    if (section && story.section !== section) return false;
    if (type && story.type !== type) return false;
    const searchable = [story.title, story.summary, story.location, sections[story.section], story.type].join(" ").toLowerCase();
    return words.every((word) => searchable.includes(word));
  }).map(toCard);
}
