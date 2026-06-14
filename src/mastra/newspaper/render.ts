import * as fs from 'fs/promises'
import * as path from 'path'

const TEMPLATES_DIR = path.join(process.cwd(), 'newspaper', 'templates')

export interface ArticleData {
  leagueName: string
  publishDate: string
  gameCount: number
  article: string
}

export interface RenderResult {
  htmlPath: string
}

function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

function markdownToHtml(md: string): string {
  const blocks = md.split(/\n{2,}/)

  return blocks
    .map(block => {
      block = block.trim()
      if (!block) return ''

      const lines = block.split('\n')
      const isList = lines.every(l => /^[-*]\s/.test(l.trim()))

      if (isList) {
        const items = lines
          .map(l => `<li>${inlineFormat(l.replace(/^[-*]\s/, '').trim())}</li>`)
          .join('\n')
        return `<ul>\n${items}\n</ul>`
      }

      return `<p>${inlineFormat(block.replace(/\n/g, ' '))}</p>`
    })
    .filter(Boolean)
    .join('\n')
}

function parseArticle(markdown: string): {
  headline: string
  lead: string
  sections: Record<string, string>
} {
  const headlineMatch = markdown.match(/^#\s+(.+)$/m)
  const headline = headlineMatch?.[1]?.trim() ?? ''

  // ## で分割
  const [firstPart, ...rest] = markdown.split(/\n(?=##\s)/)

  // 見出し行を除いたテキストがリード
  const lead = (firstPart ?? '')
    .replace(/^#[^#].+\n?/m, '')
    .trim()

  const sections: Record<string, string> = {}
  for (const part of rest) {
    const match = part.match(/^##\s+(.+?)\n([\s\S]*)/)
    if (match) {
      sections[match[1].trim()] = match[2].trim()
    }
  }

  return { headline, lead, sections }
}

export async function renderNewspaper(
  data: ArticleData,
  outputDir: string
): Promise<RenderResult> {
  const template = await fs.readFile(
    path.join(TEMPLATES_DIR, 'front-page.html'),
    'utf-8'
  )

  const { headline, lead, sections } = parseArticle(data.article)

  const html = template
    .replaceAll('{{PAPER_NAME}}', 'CAP BASEBALL WEEKLY')
    .replaceAll('{{PUBLISH_DATE}}', data.publishDate)
    .replaceAll('{{LEAGUE_NAME}}', data.leagueName)
    .replaceAll('{{GAME_COUNT}}', String(data.gameCount))
    .replace('{{HEADLINE}}', headline)
    .replace('{{LEAD}}', markdownToHtml(lead))
    .replace('{{HIGHLIGHTS}}', markdownToHtml(sections['今週のハイライト'] ?? ''))
    .replace('{{KEY_PLAYERS}}', markdownToHtml(sections['今週のキープレーヤー'] ?? ''))
    .replace('{{OTHER_NEWS}}', markdownToHtml(sections['その他の注目試合'] ?? ''))
    .replace('{{SUMMARY}}', markdownToHtml(sections['総括'] ?? ''))

  await fs.mkdir(outputDir, { recursive: true })

  const safeName = data.leagueName.replace(/[^\w　-鿿]/g, '_')
  const htmlPath = path.join(outputDir, `newspaper-${safeName}.html`)
  await fs.writeFile(htmlPath, html, 'utf-8')

  return { htmlPath }
}
