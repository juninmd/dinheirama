import { buildPortfolio } from './index.ts'

// Envia a carteira diaria do Dinheirama para o Telegram, reusando o motor de /api/portfolio.
// Rodar uma vez: bun run telegram-daily.ts  (agende via cron/k8s CronJob)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatMessage(result: Awaited<ReturnType<typeof buildPortfolio>>): string {
  const date = new Date().toLocaleDateString('pt-BR')
  const ranked = [...result.portfolio].sort((a, b) => b.decision.score - a.decision.score)
  const top = ranked.slice(0, 5)

  const lines = top.map((q) => {
    const price = q.currency === 'USD' ? `US$ ${q.price?.toFixed(2)}` : `R$ ${q.price?.toFixed(2)}`
    return `• <b>${q.ticker}</b> — ${q.decision.action.toUpperCase()} (score ${q.decision.score}/100) | ${price}`
  })

  return [
    `<b>📊 Dinheirama — Carteira do Dia (${date})</b>`,
    '',
    `<b>Top assimetrias (${result.tickersAnalyzed} ativos analisados):</b>`,
    ...lines,
    '',
    escapeHtml(result.recommendation).slice(0, 2500),
    '',
    `<i>Fonte IA: ${result.aiSource}. Uso educacional — não é recomendação formal.</i>`,
  ].join('\n')
}

async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Faltam TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID')
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  if (!res.ok) throw new Error(`Telegram status ${res.status}: ${await res.text()}`)
}

const result = await buildPortfolio()
await sendTelegram(formatMessage(result))
console.log('[telegram-daily] carteira enviada')
