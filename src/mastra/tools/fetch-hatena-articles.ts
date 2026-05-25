import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const articleSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  bookmarkCount: z.number(),
  date: z.string(),
});

export const fetchHatenaArticlesTool = createTool({
  id: 'fetch-hatena-articles',
  description: 'はてなブックマークのテクノロジーカテゴリの人気記事を取得する',
  inputSchema: z.object({
    count: z.number().optional().describe('取得する記事数（デフォルト: 20）'),
  }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    fetchedAt: z.string(),
  }),
  execute: async ({ count = 20 }) => {
    const response = await fetch('https://b.hatena.ne.jp/hotentry/it.rss', {
      headers: { 'User-Agent': 'mastra-agent/1.0' },
    });

    if (!response.ok) {
      throw new Error(`はてなブックマークの取得に失敗しました: ${response.status}`);
    }

    const xml = await response.text();
    const articles = parseRss(xml, count);

    return {
      articles,
      fetchedAt: new Date().toISOString(),
    };
  },
});

function parseRss(xml: string, count: number) {
  const items: z.infer<typeof articleSchema>[] = [];

  // はてなブックマークはRSS 1.0（RDF）形式: <item rdf:about="URL"> と属性付き
  const itemMatches = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    if (items.length >= count) break;

    const item = match[1];

    const title = decodeHtmlEntities(extractTag(item, 'title'));
    const url = extractTag(item, 'link') || extractTag(item, 'guid');
    const description = decodeHtmlEntities(stripCdata(extractTag(item, 'description')));
    const date = extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || '';
    const bookmarkCount = parseBookmarkCount(item);

    if (title && url) {
      items.push({ title, url, description, bookmarkCount, date });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function parseBookmarkCount(item: string): number {
  const match = item.match(/hatena:bookmarkcount[^>]*>(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
