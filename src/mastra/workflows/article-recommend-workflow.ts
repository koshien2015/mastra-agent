import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { execSync } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { userContextSchema } from '../tools/user-context';

// ENV:
//   CONCIERGE_USERS=t-baba,k-yoshik,t-morooka-39  (カンマ区切り GitHub username)
//   CONCIERGE_ORG=xtone                             (省略可)

const CONTEXTS_DIR = join(process.cwd(), '.data', 'contexts');

// ---- スキーマ ----

const userEntrySchema = z.object({
  username: z.string(),
  org: z.string().optional(),
});

const articleSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  bookmarkCount: z.number(),
});

const contextWithArticlesSchema = z.object({
  context: userContextSchema,
  articles: z.array(articleSchema),
});

const recommendationSchema = z.object({
  username: z.string(),
  recommendation: z.string(),
});

// ---- Step 1: ENV からユーザーリストを構築 ----

const parseUsersStep = createStep({
  id: 'parse-users',
  description: 'CONCIERGE_USERS 環境変数からユーザーリストを構築',
  inputSchema: z.object({}),
  outputSchema: z.array(userEntrySchema),
  execute: async () => {
    const usersEnv = process.env.CONCIERGE_USERS ?? '';
    const org = process.env.CONCIERGE_ORG;
    const usernames = usersEnv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (usernames.length === 0) {
      throw new Error(
        'CONCIERGE_USERS 環境変数が未設定です。例: CONCIERGE_USERS=t-baba,k-yoshik'
      );
    }
    return usernames.map(username => ({ username, org }));
  },
});

// ---- Step 2: 各ユーザーの GitHub コンテキストを収集（foreach で並列実行）----

const collectContextStep = createStep({
  id: 'collect-context',
  description: 'gh CLI でユーザーのPR・コミット情報を収集してコンテキストを構築',
  inputSchema: userEntrySchema,
  outputSchema: userContextSchema,
  execute: async ({ inputData, mastra }) => {
    const { username, org } = inputData;

    // ユーザー公開プロフィール取得
    let userJson: any = {};
    try {
      userJson = JSON.parse(
        execSync(`gh api /users/${username}`, { stdio: 'pipe' }).toString()
      );
    } catch {
      userJson = { login: username, name: username };
    }

    // 最近のPR（org指定があればorg内を優先）
    let prs: any[] = [];
    try {
      const orgFlag = org ? `--owner ${org}` : '';
      prs = JSON.parse(
        execSync(
          `gh search prs --author ${username} ${orgFlag} --state all --limit 20 --json title,body,createdAt,repository`.trim(),
          { stdio: 'pipe' }
        ).toString()
      );
    } catch {
      // gh search が使えない環境ではスキップ
    }

    // 最近のイベント（コミットメッセージ）
    let events: any[] = [];
    try {
      events = JSON.parse(
        execSync(`gh api /users/${username}/events?per_page=50`, { stdio: 'pipe' }).toString()
      );
    } catch {
      // スキップ
    }

    // ---- モデルが読みやすいテキスト形式に変換 ----

    const profileLines = [
      `名前: ${userJson.name ?? username}`,
      userJson.company ? `所属: ${userJson.company}` : '',
      userJson.bio ? `自己紹介: ${userJson.bio}` : '',
    ].filter(Boolean).join('\n');

    const prLines = prs.slice(0, 12).map((pr, i) => {
      const body = (pr.body ?? '').trim().slice(0, 600);
      const bodyText = body ? `\n    概要: ${body.replace(/\n+/g, ' ')}` : '';
      return `[${i + 1}] リポジトリ: ${pr.repository?.name ?? '不明'}\n    タイトル: ${pr.title}${bodyText}`;
    }).join('\n\n');

    const commitLines = events
      .filter((e: any) => e.type === 'PushEvent')
      .slice(0, 15)
      .flatMap((e: any) =>
        (e.payload?.commits ?? []).slice(0, 3).map((c: any) =>
          `- [${e.repo?.name ?? ''}] ${c.message.split('\n')[0]}`
        )
      )
      .join('\n');

    const inputText = [
      '## ユーザー情報',
      profileLines,
      '',
      '## 最近のPR（直近最大12件）',
      prLines || '（取得できませんでした）',
      '',
      '## 最近のコミット',
      commitLines || '（取得できませんでした）',
    ].join('\n');

    const agent = mastra?.getAgent('contextExtractorAgent');
    if (!agent) throw new Error('contextExtractorAgent not found');

    const response = await agent.generate([
      { role: 'user', content: inputText },
    ]);

    // [JSON] マーカー以降から JSON を抽出（chain-of-thought の分析部分を除外）
    const afterMarker = response.text.split('[JSON]').at(-1) ?? response.text;
    const jsonMatch = afterMarker.match(/\{[\s\S]+\}/);
    if (!jsonMatch) {
      throw new Error(
        `${username} のコンテキスト抽出失敗。レスポンス: ${response.text.slice(0, 300)}`
      );
    }

    const extracted = JSON.parse(jsonMatch[0]);
    const context = userContextSchema.parse({
      name: extracted.name || userJson.name || username,
      role: extracted.role || '不明',
      currentTasks: extracted.currentTasks?.length ? extracted.currentTasks : ['GitHub情報から取得中'],
      currentProblems: extracted.currentProblems ?? [],
      techStack: extracted.techStack ?? [],
      consideringTech: extracted.consideringTech ?? [],
      interests: extracted.interests ?? [],
      recentLearnings: extracted.recentLearnings ?? [],
      updatedAt: new Date().toISOString(),
    });

    // ユーザーごとのファイルに保存
    await mkdir(CONTEXTS_DIR, { recursive: true });
    await writeFile(
      join(CONTEXTS_DIR, `${username}.json`),
      JSON.stringify(context, null, 2),
      'utf-8'
    );

    return context;
  },
});

// ---- Step 3: Hatena RSS を1回取得して全ユーザーのコンテキストと対で返す ----

function parseHatenaRss(xml: string, limit: number): z.infer<typeof articleSchema>[] {
  const articles: z.infer<typeof articleSchema>[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    if (articles.length >= limit) break;
    const item = match[1];
    const title = decodeEntities(
      item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? ''
    );
    const url =
      item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim() ??
      item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() ?? '';
    const description = decodeEntities(
      item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() ?? ''
    );
    const bcMatch = item.match(/hatena:bookmarkcount[^>]*>(\d+)/i);
    const bookmarkCount = bcMatch ? parseInt(bcMatch[1], 10) : 0;
    if (title && url) articles.push({ title, url, description, bookmarkCount });
  }
  return articles;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const attachArticlesStep = createStep({
  id: 'attach-articles',
  description: 'はてなブックマーク記事を1回取得して全ユーザーのコンテキストと組み合わせる',
  inputSchema: z.array(userContextSchema),
  outputSchema: z.array(contextWithArticlesSchema),
  execute: async ({ inputData: contexts }) => {
    const res = await fetch('https://b.hatena.ne.jp/hotentry/it.rss', {
      headers: { 'User-Agent': 'mastra-agent/1.0' },
    });
    if (!res.ok) throw new Error(`はてなブックマーク取得失敗: ${res.status}`);
    const xml = await res.text();
    const articles = parseHatenaRss(xml, 20);

    return contexts.map(context => ({ context, articles }));
  },
});

// ---- Step 4: ユーザーごとに個別推薦を生成（foreach で並列実行）----

const recommendStep = createStep({
  id: 'recommend',
  description: 'ユーザーのコンテキストに合わせた記事推薦を生成',
  inputSchema: contextWithArticlesSchema,
  outputSchema: recommendationSchema,
  execute: async ({ inputData, mastra }) => {
    const { context, articles } = inputData;

    const contextSummary = [
      `名前: ${context.name ?? '不明'}`,
      `役割: ${context.role}`,
      `現在のタスク: ${context.currentTasks.join(' / ')}`,
      `課題: ${context.currentProblems.join(' / ') || 'なし'}`,
      `技術スタック: ${context.techStack.join(', ') || 'なし'}`,
      `検討中: ${context.consideringTech.join(', ') || 'なし'}`,
      `関心領域: ${context.interests.join(', ') || 'なし'}`,
      `最近の学び: ${context.recentLearnings.join(' / ') || 'なし'}`,
      `コンテキスト更新: ${context.updatedAt}`,
    ].join('\n');

    const articleList = articles
      .map(
        (a, i) =>
          `${i + 1}. 【${a.bookmarkCount}ブクマ】${a.title}\n   URL: ${a.url}\n   ${a.description.slice(0, 120)}`
      )
      .join('\n\n');

    const prompt = `[ワークフロー自動実行]
getUserContextツールとfetchHatenaArticlesツールの呼び出しは不要です。以下のデータを直接使用してください。

## ユーザーコンテキスト（GitHub から自動収集済み）
${contextSummary}

## はてなブックマーク 最新記事（${articles.length}件）
${articleList}

上記のコンテキストと記事リストをもとに、このユーザーの今の仕事・課題に関連する記事を選んで推薦してください。
関係ない記事は除外し、規定のフォーマット（📌 タイトル, 🔗 URL, 💡 あなたへの意味, 👉 次の一手）で出力してください。`;

    const agent = mastra?.getAgent('articleRecommendAgent');
    if (!agent) throw new Error('articleRecommendAgent not found');

    const response = await agent.generate([{ role: 'user', content: prompt }]);
    const username = context.name ?? 'unknown';
    return { username, recommendation: response.text };
  },
});

// ---- ワークフロー定義 ----

export const articleRecommendWorkflow = createWorkflow({
  id: 'article-recommend-workflow',
  inputSchema: z.object({}),
  outputSchema: z.array(recommendationSchema),
})
  .then(parseUsersStep)
  .foreach(collectContextStep, { concurrency: 3 })
  .then(attachArticlesStep)
  .foreach(recommendStep, { concurrency: 3 });

articleRecommendWorkflow.commit();
