export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Lagos" }).format(new Date(value));
}

export function storyPath(slug: string) {
  return "/articles/" + encodeURIComponent(slug);
}
