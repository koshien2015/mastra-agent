import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

function getBaseUrl() {
  return process.env.SCORESHEET_API_URL ?? 'http://localhost:3333';
}

async function fetchAnalyst(path: string) {
  const res = await fetch(`${getBaseUrl()}/scoresheet/api/v1/analyst${path}`);
  if (!res.ok) throw new Error(`Scoresheet API error: ${res.status} ${path}`);
  return res.json();
}

export const getMonthlyBattingTool = createTool({
  id: 'scoresheet-monthly-batting',
  description: '指定月の打者成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/batting/monthly?month=${encodeURIComponent(month)}`);
    return { rows, count: rows.length };
  },
});

export const getMonthlyPitchingTool = createTool({
  id: 'scoresheet-monthly-pitching',
  description: '指定月の投手成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/pitching/monthly?month=${encodeURIComponent(month)}`);
    return { rows, count: rows.length };
  },
});

export const getMonthlyCatchingTool = createTool({
  id: 'scoresheet-monthly-catching',
  description: '指定月の捕手成績一覧を取得する。月は "YYYY/M" 形式（例: 2026/5）',
  inputSchema: z.object({
    month: z.string().describe('対象月 (例: 2026/5)'),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
  }),
  execute: async ({ month }, _ctx) => {
    const rows = await fetchAnalyst(`/catching/monthly?month=${encodeURIComponent(month)}`);
    return { rows, count: rows.length };
  },
});
