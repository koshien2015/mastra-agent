import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

type RawRow = Record<string, unknown>;

const battingCandidateSchema = z.object({
  playerName: z.string(),
  teamName: z.string().nullable(),
  plateAppearances: z.number().nullable(),
  tpa: z.number().nullable(),
  atBat: z.number().nullable(),
  at_bats: z.number().nullable(),
  average: z.number().nullable(),
  obp: z.number().nullable(),
  slg: z.number().nullable(),
  ops: z.number().nullable(),
  hits: z.number().nullable(),
  homeRuns: z.number().nullable(),
  rbi: z.number().nullable(),
  runs: z.number().nullable(),
  bigHit: z.number().nullable(),
  decisiveRun: z.number().nullable(),
});

const pitchingCandidateSchema = z.object({
  playerName: z.string(),
  teamName: z.string().nullable(),
  inningsPitched: z.number().nullable(),
  era: z.number().nullable(),
  earnedRuns: z.number().nullable(),
  wins: z.number().nullable(),
  losses: z.number().nullable(),
  saves: z.number().nullable(),
  holds: z.number().nullable(),
  strikeouts: z.number().nullable(),
  walks: z.number().nullable(),
});

const catchingCandidateSchema = z.object({
  playerName: z.string(),
  teamName: z.string().nullable(),
  inningsCaught: z.number().nullable(),
  era: z.number().nullable(),
  earnedRuns: z.number().nullable(),
  wins: z.number().nullable(),
  losses: z.number().nullable(),
  saves: z.number().nullable(),
  passedBalls: z.number().nullable(),
  wildPitches: z.number().nullable(),
});

const toolSummarySchema = z.object({
  month: z.string(),
  totalRows: z.number(),
  eligibleRows: z.number(),
  excludedRows: z.number(),
  filterReason: z.string(),
});

const rawRowsSchema = z.array(z.record(z.string(), z.unknown()));

function getBaseUrl() {
  return process.env.SCORESHEET_API_URL ?? 'http://localhost:3333';
}

async function fetchAnalyst(path: string): Promise<RawRow[]> {
  const res = await fetch(`${getBaseUrl()}/scoresheet/api/v1/analyst${path}`);
  if (!res.ok) throw new Error(`Scoresheet API error: ${res.status} ${path}`);
  return res.json();
}

function pickValue(row: RawRow, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function roundStat(value: number | null, digits = 3) {
  if (value === null) return null;
  return Number(value.toFixed(digits));
}

function computeEra(earnedRuns: number | null, innings: number | null, multiplier: number) {
  if (earnedRuns === null || innings === null || innings <= 0) return null;
  return roundStat((earnedRuns / innings) * multiplier, 2);
}

function sortByMetrics<T>(rows: T[], selectors: Array<(row: T) => number | null>) {
  return [...rows].sort((left, right) => {
    for (const selector of selectors) {
      const leftValue = selector(left);
      const rightValue = selector(right);
      if (leftValue === rightValue) continue;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue;
    }
    return 0;
  });
}

function getPlayerName(row: RawRow) {
  return asString(pickValue(row, ['player_name', 'playerName', 'name', 'player', '選手名', '氏名'])) ?? '不明';
}

function getTeamName(row: RawRow) {
  return asString(pickValue(row, ['team_name', 'teamName', 'team', 'team_short', 'チーム名', 'チーム']));
}

function normalizeBattingRow(row: RawRow) {
  const plateAppearances = asNumber(
    pickValue(row, ['tpa', 'plate_appearances', 'plateAppearances', 'pa', '打席']),
  );
  const atBat = asNumber(pickValue(row, ['at_bats', 'at_bat', 'atBat', 'ab', '打数']));

  return {
    playerName: getPlayerName(row),
    teamName: getTeamName(row),
    plateAppearances,
    tpa: plateAppearances,
    atBat,
    at_bats: atBat,
    average: roundStat(asNumber(pickValue(row, ['average', 'avg', '打率']))),
    obp: roundStat(asNumber(pickValue(row, ['obp', 'on_base_percentage', '出塁率']))),
    slg: roundStat(asNumber(pickValue(row, ['slg', 'slugging', '長打率']))),
    ops: roundStat(asNumber(pickValue(row, ['ops', 'ＯＰＳ']))),
    hits: asNumber(pickValue(row, ['hits', 'hit', '安打'])),
    homeRuns: asNumber(pickValue(row, ['home_runs', 'homeRun', 'hr', '本塁打'])),
    rbi: asNumber(pickValue(row, ['rbi', '打点'])),
    runs: asNumber(pickValue(row, ['runs', 'run', '得点'])),
    bigHit: asNumber(pickValue(row, ['big_hit', 'bigHit', '殊勲打'])),
    decisiveRun: asNumber(pickValue(row, ['decisive_run', 'decisiveRun', '決勝点'])),
  };
}

function normalizePitchingRow(row: RawRow) {
  const inningsPitched = asNumber(pickValue(row, ['inning', 'innings', 'innings_pitched', '投球回']));
  const earnedRuns = asNumber(pickValue(row, ['er', 'earned_runs', 'earnedRun', '自責点']));
  const era = roundStat(
    asNumber(pickValue(row, ['era', 'ERA', '防御率'])) ?? computeEra(earnedRuns, inningsPitched, 9),
    2,
  );

  return {
    playerName: getPlayerName(row),
    teamName: getTeamName(row),
    inningsPitched,
    era,
    earnedRuns,
    wins: asNumber(pickValue(row, ['wins', 'win', '勝利'])),
    losses: asNumber(pickValue(row, ['losses', 'loss', 'lose', '敗戦'])),
    saves: asNumber(pickValue(row, ['saves', 'save', 'セーブ'])),
    holds: asNumber(pickValue(row, ['holds', 'hold', 'ホールド'])),
    strikeouts: asNumber(pickValue(row, ['strikeouts', 'so', 'k', '奪三振'])),
    walks: asNumber(pickValue(row, ['walks', 'bb', '与四球'])),
  };
}

function normalizeCatchingRow(row: RawRow) {
  const inningsCaught = asNumber(
    pickValue(row, ['inning', 'innings', 'innings_caught', '守備イニング', '投球回']),
  );
  const earnedRuns = asNumber(pickValue(row, ['er', 'earned_runs', 'earnedRun', '自責点']));
  const era = roundStat(
    asNumber(pickValue(row, ['era', 'ERA', '防御率'])) ?? computeEra(earnedRuns, inningsCaught, 9),
    2,
  );

  return {
    playerName: getPlayerName(row),
    teamName: getTeamName(row),
    inningsCaught,
    era,
    earnedRuns,
    wins: asNumber(pickValue(row, ['wins', 'win', '勝利'])),
    losses: asNumber(pickValue(row, ['losses', 'loss', 'lose', '敗戦'])),
    saves: asNumber(pickValue(row, ['saves', 'save', 'セーブ'])),
    passedBalls: asNumber(pickValue(row, ['pb', 'passed_ball', 'passedBalls', '捕逸'])),
    wildPitches: asNumber(pickValue(row, ['wp', 'wild_pitch', 'wildPitches', '暴投'])),
  };
}

function summarizeBatting(month: string, rows: RawRow[]) {
  const normalized = rows.map(normalizeBattingRow);
  const eligible = sortByMetrics(normalized, [
    row => row.plateAppearances ?? row.atBat,
    row => row.ops,
    row => row.homeRuns,
    row => row.rbi,
  ]).slice(0, 50);
  const candidates = sortByMetrics(eligible, [
    row => row.ops,
    row => row.homeRuns,
    row => row.rbi,
    row => row.hits,
  ]).slice(0, 12);

  return {
    summary: {
      month,
      totalRows: rows.length,
      eligibleRows: eligible.length,
      excludedRows: rows.length - eligible.length,
      filterReason: '打席数の多い順に上位50人を抽出（打席がない場合は打数を代用）',
    },
    candidates,
  };
}

function summarizePitching(month: string, rows: RawRow[]) {
  const normalized = rows.map(normalizePitchingRow);
  const eligible = normalized.filter(row => (row.inningsPitched ?? 0) >= 1);
  const candidates = sortByMetrics(eligible, [
    row => (row.era === null ? null : -row.era),
    row => row.wins,
    row => row.saves,
    row => row.holds,
    row => row.strikeouts,
  ]).slice(0, 12);

  return {
    summary: {
      month,
      totalRows: rows.length,
      eligibleRows: eligible.length,
      excludedRows: rows.length - eligible.length,
      filterReason: '投球回1未満の選手を除外',
    },
    candidates,
  };
}

function summarizeCatching(month: string, rows: RawRow[]) {
  const normalized = rows.map(normalizeCatchingRow);
  const eligible = normalized.filter(row => (row.inningsCaught ?? 0) >= 1);
  const candidates = sortByMetrics(eligible, [
    row => (row.era === null ? null : -row.era),
    row => row.wins,
    row => row.saves,
    row => (row.passedBalls === null ? null : -row.passedBalls),
    row => (row.wildPitches === null ? null : -row.wildPitches),
  ]).slice(0, 12);

  return {
    summary: {
      month,
      totalRows: rows.length,
      eligibleRows: eligible.length,
      excludedRows: rows.length - eligible.length,
      filterReason: '守備イニング1未満の選手を除外',
    },
    candidates,
  };
}

export const getMonthlyBattingTool = createTool({
  id: 'scoresheet-monthly-batting',
  description: '指定月の打者成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: rawRowsSchema,
    count: z.number(),
    summary: toolSummarySchema,
    candidates: z.array(battingCandidateSchema),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/batting/monthly?month=${encodeURIComponent(month)}`);
    const { summary, candidates } = summarizeBatting(month, rows);
    return { rows, count: rows.length, summary, candidates };
  },
  toModelOutput: output => ({
    type: 'json',
    value: {
      summary: output.summary,
      candidates: output.candidates,
    },
  }),
});

export const getMonthlyPitchingTool = createTool({
  id: 'scoresheet-monthly-pitching',
  description: '指定月の投手成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: rawRowsSchema,
    count: z.number(),
    summary: toolSummarySchema,
    candidates: z.array(pitchingCandidateSchema),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/pitching/monthly?month=${encodeURIComponent(month)}`);
    const { summary, candidates } = summarizePitching(month, rows);
    return { rows, count: rows.length, summary, candidates };
  },
  toModelOutput: output => ({
    type: 'json',
    value: {
      summary: output.summary,
      candidates: output.candidates,
    },
  }),
});

export const getMonthlyCatchingTool = createTool({
  id: 'scoresheet-monthly-catching',
  description: '指定月の捕手成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: rawRowsSchema,
    count: z.number(),
    summary: toolSummarySchema,
    candidates: z.array(catchingCandidateSchema),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/catching/monthly?month=${encodeURIComponent(month)}`);
    const { summary, candidates } = summarizeCatching(month, rows);
    return { rows, count: rows.length, summary, candidates };
  },
  toModelOutput: output => ({
    type: 'json',
    value: {
      summary: output.summary,
      candidates: output.candidates,
    },
  }),
});
