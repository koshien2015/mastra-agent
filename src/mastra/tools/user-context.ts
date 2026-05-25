import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const USER_CONTEXT_PATH = join(process.cwd(), '.data', 'user-context.json');

export const userContextSchema = z.object({
  name: z.string().optional(),
  role: z.string().describe('職種・役割'),
  currentTasks: z.array(z.string()).describe('今週・今月取り組んでいる具体的なタスク'),
  currentProblems: z.array(z.string()).describe('今詰まっている・解決したい技術的な問題'),
  techStack: z.array(z.string()).describe('現在使っている技術スタック'),
  consideringTech: z.array(z.string()).describe('採用・導入を検討している技術'),
  interests: z.array(z.string()).describe('関心のある技術領域・トピック'),
  recentLearnings: z.array(z.string()).describe('最近読んで参考になったもの・学んだこと'),
  updatedAt: z.string(),
});

export type UserContext = z.infer<typeof userContextSchema>;

async function readContext(): Promise<UserContext | null> {
  try {
    const raw = await readFile(USER_CONTEXT_PATH, 'utf-8');
    return userContextSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeContext(ctx: UserContext): Promise<void> {
  await mkdir(join(process.cwd(), '.data'), { recursive: true });
  await writeFile(USER_CONTEXT_PATH, JSON.stringify(ctx, null, 2), 'utf-8');
}

export const saveUserContextTool = createTool({
  id: 'save-user-context',
  description: 'ユーザーのコンテキスト（役割・現在のタスク・課題・技術スタック等）を保存する。会話から得た情報を随時更新する。',
  inputSchema: userContextSchema.omit({ updatedAt: true }),
  outputSchema: z.object({ saved: z.boolean() }),
  execute: async (input) => {
    await writeContext({ ...input, updatedAt: new Date().toISOString() });
    return { saved: true };
  },
});

export const getUserContextTool = createTool({
  id: 'get-user-context',
  description: '保存済みのユーザーコンテキストを取得する。記事推薦の前に必ず呼び出す。',
  inputSchema: z.object({}),
  outputSchema: z.object({
    context: userContextSchema.nullable(),
    hasContext: z.boolean(),
  }),
  execute: async () => {
    const context = await readContext();
    return { context, hasContext: context !== null };
  },
});
