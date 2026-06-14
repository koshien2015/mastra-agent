import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SCORESHEET_URL = process.env.SCORESHEET_API_URL ?? 'http://localhost:3333';

function getTempDir(startDate: string, outputDir?: string): string {
  const base = outputDir ?? path.join(PROJECT_ROOT, 'generated', 'newspaper');
  return path.join(base, startDate);
}

// ---- スキーマ ----

const gameSchema = z.object({
  game_id: z.string(),
  game_date: z.string(),
  league_id: z.string(),
  league_name: z.string(),
  first_team_name: z.string(),
  last_team_name: z.string(),
  first_run: z.number().nullable(),
  last_run: z.number().nullable(),
  tempDir: z.string(),
});

const gameSummarySchema = z.object({
  game_id: z.string(),
  game_date: z.string(),
  league_id: z.string(),
  league_name: z.string(),
  first_team_name: z.string(),
  last_team_name: z.string(),
  score: z.string(),
  summary: z.string(),
  tempDir: z.string(),
});

const leagueArticleSchema = z.object({
  leagueId: z.string(),
  leagueName: z.string(),
  gameCount: z.number(),
  article: z.string(),
  filePath: z.string(),
});

// ---- Step 1: 試合一覧を取得 ----

const fetchGamesStep = createStep({
  id: 'fetch-games',
  description: '指定週の試合一覧を取得して games.json に保存',
  inputSchema: z.object({
    startDate: z.string().describe('開始日 (YYYY-MM-DD)'),
    endDate: z.string().describe('終了日 (YYYY-MM-DD)'),
    outputDir: z.string().optional().describe('出力先ディレクトリ（省略時は /tmp）'),
  }),
  outputSchema: z.array(gameSchema),
  execute: async ({ inputData }) => {
    const { startDate, endDate, outputDir } = inputData;
    const tempDir = getTempDir(startDate, outputDir);
    await fs.mkdir(path.join(tempDir, 'summaries'), { recursive: true });

    const res = await fetch(
      `${SCORESHEET_URL}/scoresheet/api/v1/game?start_date=${startDate}&end_date=${endDate}`
    );
    if (!res.ok) throw new Error(`Game list API error: ${res.status}`);
    const games: any[] = await res.json();

    await fs.writeFile(
      path.join(tempDir, 'games.json'),
      JSON.stringify(games, null, 2)
    );

    return games
      .filter(g => !g.is_private && g.locked)
      .map(g => ({
        game_id: String(g.game_id),
        game_date: String(g.game_date ?? ''),
        league_id: String(g.league_id ?? 'unknown'),
        league_name: String(g.name ?? `league-${g.league_id ?? 'unknown'}`),
        first_team_name: g.first_team_name ?? '',
        last_team_name: g.last_team_name ?? '',
        first_run: g.first_run ?? null,
        last_run: g.last_run ?? null,
        tempDir,
      }));
  },
});

// ---- Step 2: 1試合を要約（foreach で並列実行）----

const summarizeGameStep = createStep({
  id: 'summarize-game',
  description: '1試合のメモを取得してAIで要約し summaries/{id}.json に保存',
  inputSchema: gameSchema,
  outputSchema: gameSummarySchema,
  execute: async ({ inputData, mastra }) => {
    const { game_id, game_date, league_id, league_name, first_team_name, last_team_name,
            first_run, last_run, tempDir } = inputData;
    const summaryPath = path.join(tempDir, 'summaries', `game_${game_id}.json`);

    // 既存ファイルがあればスキップ（再実行時の安全性）
    try {
      const cached = await fs.readFile(summaryPath, 'utf-8');
      return JSON.parse(cached) as z.infer<typeof gameSummarySchema>;
    } catch {
      // ファイルなし → 処理続行
    }

    const score = `${first_run ?? '?'} - ${last_run ?? '?'}`;

    const memoRes = await fetch(
      `${SCORESHEET_URL}/scoresheet/api/v1/game/${game_id}/memo`
    );
    if (!memoRes.ok || memoRes.status === 404) {
      const fallback: z.infer<typeof gameSummarySchema> = {
        game_id, game_date, league_id, league_name, first_team_name, last_team_name,
        score, summary: '（試合データなし）', tempDir,
      };
      await fs.writeFile(summaryPath, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const { memo } = await memoRes.json();
    if (!memo) {
      const fallback: z.infer<typeof gameSummarySchema> = {
        game_id, game_date, league_id, league_name, first_team_name, last_team_name,
        score, summary: '（試合データなし）', tempDir,
      };
      await fs.writeFile(summaryPath, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const agent = mastra?.getAgent('gameSummaryAgent');
    if (!agent) throw new Error('gameSummaryAgent not found');

    const response = await agent.generate([{ role: 'user', content: memo }]);

    const result: z.infer<typeof gameSummarySchema> = {
      game_id, game_date, league_id, league_name, first_team_name, last_team_name,
      score, summary: response.text, tempDir,
    };

    await fs.writeFile(summaryPath, JSON.stringify(result, null, 2));
    return result;
  },
});

// ---- Step 3: 全要約からニュース記事を生成 ----

const generateNewsStep = createStep({
  id: 'generate-news',
  description: '全試合要約からスポーツニュース記事を生成して news.md に保存',
  inputSchema: z.array(gameSummarySchema),
  outputSchema: z.object({
    article: z.string(),
    filePath: z.string(),
    leagueArticles: z.array(leagueArticleSchema),
  }),
  execute: async ({ inputData, mastra }) => {
    const summaries = inputData.filter(s => s.summary !== '（試合データなし）');
    if (summaries.length === 0) {
      return { article: '対象試合なし', filePath: '', leagueArticles: [] };
    }

    const tempDir = summaries[0].tempDir;
    const newsDir = path.join(tempDir, 'news-by-league');
    const newsPath = path.join(tempDir, 'news.md');
    await fs.mkdir(newsDir, { recursive: true });

    const agent = mastra?.getAgent('sportsNewsAgent');
    if (!agent) throw new Error('sportsNewsAgent not found');

    const groups = new Map<string, z.infer<typeof gameSummarySchema>[]>();
    for (const summary of summaries) {
      const group = groups.get(summary.league_id);
      if (group) {
        group.push(summary);
      } else {
        groups.set(summary.league_id, [summary]);
      }
    }

    const leagueArticles: z.infer<typeof leagueArticleSchema>[] = [];

    for (const [leagueId, leagueSummaries] of groups.entries()) {
      const leagueName = leagueSummaries[0]?.league_name ?? `league-${leagueId}`;
      const summaryText = leagueSummaries
        .map(s =>
          `## ${s.game_date}  ${s.first_team_name} ${s.score} ${s.last_team_name}\n\n${s.summary}`
        )
        .join('\n\n---\n\n');

      const response = await agent.generate([
        {
          role: 'user',
          content: `対象リーグ: ${leagueName} (league_id: ${leagueId})\n対象試合数: ${leagueSummaries.length}\n\n以下の試合要約をもとに、このリーグだけの週刊スポーツニュース記事を書いてください。\n\n${summaryText}`,
        },
      ]);

      const leagueFilePath = path.join(newsDir, `league_${leagueId}.md`);
      await fs.writeFile(leagueFilePath, response.text);

      leagueArticles.push({
        leagueId,
        leagueName,
        gameCount: leagueSummaries.length,
        article: response.text,
        filePath: leagueFilePath,
      });
    }

    const combinedArticle = leagueArticles
      .map(
        league =>
          `# ${league.leagueName} の週刊ニュース\n\n${league.article}`
      )
      .join('\n\n---\n\n');

    await fs.writeFile(newsPath, combinedArticle);

    return { article: combinedArticle, filePath: newsPath, leagueArticles };
  },
});

// ---- ワークフロー定義 ----

export const weeklyNewsWorkflow = createWorkflow({
  id: 'weekly-news-workflow',
  inputSchema: z.object({
    startDate: z.string().describe('週の開始日 (YYYY-MM-DD)'),
    endDate: z.string().describe('週の終了日 (YYYY-MM-DD)'),
    outputDir: z.string().optional().describe('出力先ディレクトリ（省略時は /tmp）'),
  }),
  outputSchema: z.object({
    article: z.string(),
    filePath: z.string(),
    leagueArticles: z.array(leagueArticleSchema),
  }),
})
  .then(fetchGamesStep)
  .foreach(summarizeGameStep, { concurrency: 3 })
  .then(generateNewsStep);

weeklyNewsWorkflow.commit();
