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

function escapeGhValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function ghApi<T>(path: string, fallback: T, options?: { accept?: string }): T {
  const escapedPath = escapeGhValue(path);
  const acceptHeader = options?.accept
    ? ` -H "Accept: ${escapeGhValue(options.accept)}"`
    : '';

  try {
    const stdout = execSync(`gh api "${escapedPath}"${acceptHeader}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return JSON.parse(stdout) as T;
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() ?? '';
    const stdout = error?.stdout?.toString?.() ?? '';
    const message = `${stderr}\n${stdout}`.trim();

    if (message.includes('401') || message.includes('Requires authentication')) {
      throw new Error(
        'gh authentication failed. Run `gh auth login` or refresh the current token before running this workflow.'
      );
    }

    return fallback;
  }
}

function extractRepoName(url: string): string {
  return url.replace('https://api.github.com/repos/', '');
}

type GitHubProfile = {
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
};

type GitHubRepo = {
  name: string;
  description: string | null;
  language: string | null;
};

type GitHubEvent = {
  type: string;
  repo: { name: string };
  payload?: { commits?: { message: string }[] };
};

type SearchItem = {
  title: string;
  body: string | null;
  labels?: { name: string }[];
  repository_url?: string;
};

type SearchResult = {
  total_count: number;
  items: SearchItem[];
};

type CommitSearchItem = {
  commit: {
    message: string;
    author: { date: string };
  };
  repository: { full_name: string };
};

type CommitSearchResult = {
  total_count: number;
  items: CommitSearchItem[];
};

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

    const profile = ghApi<GitHubProfile>(`/users/${username}`, {
      name: username,
      bio: null,
      company: null,
      location: null,
    });

    const repos = ghApi<GitHubRepo[]>(
      `/users/${username}/repos?sort=pushed&per_page=20`,
      []
    );

    const events = ghApi<GitHubEvent[]>(
      `/users/${username}/events?per_page=30`,
      []
    );

    const langCount: Record<string, number> = {};
    for (const repo of repos) {
      if (repo.language) {
        langCount[repo.language] = (langCount[repo.language] ?? 0) + 1;
      }
    }

    const topLanguages = Object.entries(langCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([language]) => language);

    const recentRepos = [
      ...new Set(
        events
          .filter(event => event.type === 'PushEvent')
          .map(event => event.repo.name.replace(`${username}/`, ''))
      ),
    ].slice(0, 5);

    const commitMessages = events
      .filter(event => event.type === 'PushEvent' && event.payload?.commits)
      .flatMap(event =>
        (event.payload?.commits ?? []).map(commit => commit.message.split('\n')[0])
      )
      .slice(0, 10);

    const repoSummaries = repos.slice(0, 8).map(repo => ({
      name: repo.name,
      description: repo.description,
      language: repo.language,
    }));

    let orgPRs: { title: string; body: string | null; repo: string; labels: string[] }[] = [];
    let orgIssues: { title: string; body: string | null; repo: string; labels: string[] }[] = [];
    let orgCommitMessages: string[] = [];
    let orgRepoNames: string[] = [];

    if (org) {
      const prSearch = ghApi<SearchResult>(
        `/search/issues?q=author:${username}+org:${org}+is:pr&sort=updated&per_page=15`,
        { total_count: 0, items: [] }
      );
      orgPRs = prSearch.items.map(item => ({
        title: item.title,
        body: item.body ? item.body.slice(0, 400) : null,
        repo: item.repository_url ? extractRepoName(item.repository_url) : '',
        labels: (item.labels ?? []).map(label => label.name),
      }));

      const issueSearch = ghApi<SearchResult>(
        `/search/issues?q=author:${username}+org:${org}+is:issue&sort=updated&per_page=10`,
        { total_count: 0, items: [] }
      );
      orgIssues = issueSearch.items.map(item => ({
        title: item.title,
        body: item.body ? item.body.slice(0, 200) : null,
        repo: item.repository_url ? extractRepoName(item.repository_url) : '',
        labels: (item.labels ?? []).map(label => label.name),
      }));

      const commitSearch = ghApi<CommitSearchResult>(
        `/search/commits?q=author:${username}+org:${org}&sort=author-date&per_page=15`,
        { total_count: 0, items: [] },
        { accept: 'application/vnd.github.cloak-preview+json' }
      );
      orgCommitMessages = commitSearch.items.map(
        item => `[${item.repository.full_name}] ${item.commit.message.split('\n')[0]}`
      );

      const orgRepos = ghApi<{ name: string }[]>(
        `/orgs/${org}/repos?sort=pushed&per_page=30&type=all`,
        []
      );
      orgRepoNames = orgRepos.map(repo => repo.name);

      const orgReposFull = ghApi<{ language: string | null }[]>(
        `/orgs/${org}/repos?sort=pushed&per_page=15&type=all`,
        []
      );
      for (const repo of orgReposFull) {
        if (repo.language) {
          langCount[repo.language] = (langCount[repo.language] ?? 0) + 1;
        }
      }
    }

    // ---- モデルが読みやすいテキスト形式に変換 ----

    const profileLines = [
      `名前: ${profile.name ?? username}`,
      profile.company ? `所属: ${profile.company}` : '',
      profile.location ? `所在地: ${profile.location}` : '',
      profile.bio ? `自己紹介: ${profile.bio}` : '',
    ].filter(Boolean).join('\n');

    const repoLines = repoSummaries
      .map(
        repo =>
          `- ${repo.name}: ${repo.description ?? '説明なし'} (${repo.language ?? '不明'})`
      )
      .join('\n');

    const commitLines = commitMessages.map(message => `- ${message}`).join('\n');

    const orgPrLines = orgPRs
      .map(pr => {
        const labels = pr.labels.length > 0 ? ` (${pr.labels.join(', ')})` : '';
        const body = pr.body ? `\n    説明: ${pr.body.replace(/\n+/g, ' ')}` : '';
        return `- [${pr.repo}] ${pr.title}${labels}${body}`;
      })
      .join('\n');

    const orgIssueLines = orgIssues
      .map(issue => {
        const labels = issue.labels.length > 0 ? ` (${issue.labels.join(', ')})` : '';
        const body = issue.body ? `\n    内容: ${issue.body.replace(/\n+/g, ' ')}` : '';
        return `- [${issue.repo}] ${issue.title}${labels}${body}`;
      })
      .join('\n');

    const orgCommitLines = orgCommitMessages.map(message => `- ${message}`).join('\n');

    const inputText = [
      '## ユーザー情報',
      profileLines,
      '',
      '## 主要言語',
      topLanguages.join(', ') || '（取得できませんでした）',
      '',
      '## 最近アクティブなリポジトリ',
      recentRepos.join(', ') || '（取得できませんでした）',
      '',
      '## 個人リポジトリ一覧（最近）',
      repoLines || '（取得できませんでした）',
      '',
      '## 公開コミットメッセージ（サンプル）',
      commitLines || '（取得できませんでした）',
    ];

    if (org) {
      inputText.push(
        '',
        `## 組織「${org}」での活動`,
        '',
        `### 最近のPull Request（${orgPRs.length}件）`,
        orgPrLines || 'なし',
        '',
        `### 最近のIssue（${orgIssues.length}件）`,
        orgIssueLines || 'なし',
        '',
        '### 組織内コミットメッセージ（サンプル）',
        orgCommitLines || 'なし',
        '',
        '### 組織のリポジトリ（最近アクティブ）',
        orgRepoNames.slice(0, 10).join(', ') || 'なし'
      );
    }

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
      name: extracted.name || profile.name || username,
      role: extracted.role || '不明',
      currentTasks: extracted.currentTasks?.length ? extracted.currentTasks : ['GitHub情報から取得中'],
      currentProblems: extracted.currentProblems ?? [],
      techStack: extracted.techStack?.length ? extracted.techStack : topLanguages,
      consideringTech: extracted.consideringTech ?? [],
      interests: extracted.interests ?? [],
      recentLearnings:
        extracted.recentLearnings?.length
          ? extracted.recentLearnings
          : recentRepos.slice(0, 3),
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
