import { canonicalJson } from "../research/contracts.ts";
import { identity, sections } from "./types.ts";
import type { Article, ArticleFormat, Material, Section, WritingInput, WritingResult } from "./types";

const leads: Partial<Record<ArticleFormat, Section[]>> = {
  historical_explainer: ["overview", "history", "facts", "limitations"],
  geopolitical_analysis: ["overview", "analysis", "scenarios", "facts", "history", "limitations"],
  investigative_report: ["overview", "facts", "limitations", "history", "analysis"],
  special_feature: ["overview", "history", "analysis", "facts", "scenarios", "limitations"],
  factcheck_report: ["overview", "facts", "limitations"],
};

export function articleWords(standfirst: string, material: Material[]): number {
  return [standfirst, ...material.map((block) => block.text)].join(" ").trim().split(/\s+/u).length;
}

function briefMaterial(material: Material[]) {
  return material.filter((block) => block.section === "overview" || block.section === "facts"
    || block.id === "guide:history" || block.id === "guide:limits");
}

export function writeArticle(input: WritingInput): WritingResult {
  const articles = input.formats.map((format): Article => {
    const material = format === "quick_brief" ? briefMaterial(input.material) : input.material;
    const order = leads[format] ?? sections;
    const retained = material.filter(({ section }) => order.includes(section));
    return {
      format, headlines: input.headlines, standfirst: input.standfirst,
      sections: order.map((kind) => ({ kind, blocks: material.filter((block) => block.section === kind) }))
        .filter(({ blocks }) => blocks.length > 0),
      wordCount: articleWords(input.standfirst, retained),
    };
  });
  return {
    ...identity(input), stage: "writing", researchId: input.researchId, sourceRegister: input.sourceRegister,
    articles, proposedClaims: [],
  };
}

export function groundedArticles(articles: Article[], material: Material[]): boolean {
  const catalog = new Map(material.map((block) => [block.id, canonicalJson(block)]));
  const verified = material.filter((block) => block.frame === "verified_fact").map((block) => block.id);
  return articles.every((article) => {
    const used = article.sections.flatMap(({ blocks }) => blocks);
    const ids = new Set(used.map((block) => block.id));
    return ids.size === used.length && new Set(article.sections.map(({ kind }) => kind)).size === article.sections.length
      && verified.length > 0 && verified.every((id) => ids.has(id))
      && articleWords(article.standfirst, used) === article.wordCount
      && article.sections.every(({ kind, blocks }) => blocks.every((block) =>
        block.section === kind && catalog.get(block.id) === canonicalJson(block)));
  });
}

export function validWriting(input: WritingInput, result: WritingResult): boolean {
  const evidence = new Set(input.material.flatMap(({ evidenceIds }) => evidenceIds));
  return result.researchId === input.researchId
    && canonicalJson(result.sourceRegister) === canonicalJson(input.sourceRegister)
    && canonicalJson(result.articles.map(({ format }) => format)) === canonicalJson(input.formats)
    && result.articles.every(({ headlines, standfirst }) => canonicalJson(headlines) === canonicalJson(input.headlines)
      && standfirst === input.standfirst)
    && groundedArticles(result.articles, input.material)
    && result.proposedClaims.every(({ evidenceIds }) => evidenceIds.every((id) => evidence.has(id)));
}
