import { buildPortfolio } from './index.ts'
import { formatMessage, sendTelegram } from './telegram-daily.ts'
import { getAlerts, addAlert, deleteAlert } from './alerts-manager.ts'

// Bot interativo do Dinheirama: escuta comandos no Telegram via long-polling (getUpdates)
// e responde com analises sob demanda, reusando o motor de /api/* do servidor local.
// Roda in-process junto ao servidor (index.ts) ou avulso: bun run telegram-bot.ts.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000'
// Restringe o bot a um chat. Vazio = responde a qualquer chat (use com cautela).
const ALLOWED_CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim()

const HELP = [
  '<b>🤖 Dinheirama — assistente de trade 24h</b>',
  '',
  'Comandos:',
  '• <code>/radar</code> — top assimetrias ações + cripto',
  '• <code>/analise PETR4.SA</code> — análise completa de um ativo',
  '• <code>/research BTC-USD</code> — notícias e papers do ativo',
  '• <code>/predict VALE3.SA</code> — sinal do modelo ML',
  '• <code>/alertas</code> — lista todos os alertas ativos',
  '• <code>/alerta [ativo] [tipo] [condição] [valor]</code> — cria um alerta',
  '  Ex: <code>/alerta BTC-USD preco &gt; 75000</code>',
  '  Ex: <code>/alerta PETR4.SA rsi &lt; 30</code>',
  '  Ex: <code>/alerta VALE3.SA sinal buy</code>',
  '• <code>/delalerta [id]</code> — remove um alerta por ID',
  '• <code>/ajuda</code> — esta mensagem de ajuda',
  '',
  '<i>Uso educacional. Não é recomendação formal de investimento.</i>',
].join('\n')

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase()
}

async function handleRadar(chatId: number): Promise<void> {
  const result = await buildPortfolio()
  await sendTelegram(formatMessage(result), chatId)
}

async function handleAnalyze(chatId: number, ticker: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker }),
  })
  if (!res.ok) {
    await sendTelegram(`⚠️ Falha ao analisar ${escapeHtml(ticker)} (status ${res.status}).`, chatId)
    return
  }
  const d = await res.json() as any
  const header = [
    `<b>📈 ${escapeHtml(d.ticker)}</b> (${d.assetClass}) — ${String(d.action).toUpperCase()} ${d.score}/100`,
    `Preço ${d.quote?.price?.toFixed?.(2) ?? 'N/A'} | RSI ${d.rsi?.toFixed?.(0) ?? 'N/A'} | risco ${d.risk}`,
    `Impacto: ${d.newsImpact?.label}/${d.newsImpact?.score}`,
    d.mlPrediction ? `ML: ${d.mlPrediction.label ?? d.mlPrediction.action ?? JSON.stringify(d.mlPrediction)}` : '',
    '',
  ].filter(Boolean).join('\n')
  const analysis = escapeHtml(String(d.analysis || '')).slice(0, 3500)
  await sendTelegram(`${header}${analysis}\n\n<i>Fonte: ${d.aiSource}. Não é recomendação formal.</i>`, chatId)
}

async function handleResearch(chatId: number, ticker: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/research/${encodeURIComponent(ticker)}`)
  if (!res.ok) {
    await sendTelegram(`⚠️ Falha na pesquisa de ${escapeHtml(ticker)} (status ${res.status}).`, chatId)
    return
  }
  const d = await res.json() as any
  const items = (d.items || []).slice(0, 6).map((it: any) =>
    `• [${it.impact}] ${escapeHtml(String(it.title || '').slice(0, 140))}${it.url ? ` — ${escapeHtml(it.url)}` : ''}`
  )
  const lines = [
    `<b>🔎 Research ${escapeHtml(d.asset)}</b> — impacto ${d.impact?.label}/${d.impact?.score}`,
    escapeHtml(d.impact?.summary || ''),
    '',
    ...(items.length ? items : ['Sem sinais externos encontrados (configure FAST_NEWS_URL / MARKET_NEWS_FEEDS).']),
  ]
  await sendTelegram(lines.join('\n'), chatId)
}

async function handlePredict(chatId: number, ticker: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/predict?ticker=${encodeURIComponent(ticker)}`)
  if (!res.ok) {
    await sendTelegram(`⚠️ Falha na predição de ${escapeHtml(ticker)} (status ${res.status}).`, chatId)
    return
  }
  const d = await res.json() as any
  const p = d.prediction || {}
  await sendTelegram([
    `<b>🧠 ML ${escapeHtml(d.ticker)}</b>`,
    `Preço ${d.quote?.price?.toFixed?.(2) ?? 'N/A'} | variação ${d.quote?.change?.toFixed?.(2) ?? 'N/A'}%`,
    `Sinal: ${escapeHtml(JSON.stringify(p))}`,
    `Modelo carregado: ${d.modelLoaded ? 'sim' : 'fallback'}`,
  ].join('\n'), chatId)
}

async function handleListAlerts(chatId: number): Promise<void> {
  const list = getAlerts()
  if (list.length === 0) {
    await sendTelegram('🔔 Não há alertas ativos no momento.', chatId)
    return
  }
  const lines = list.map(a => {
    const statusSymbol = a.status === 'active' ? '🟢' : a.status === 'triggered' ? '🔴' : '⚪'
    return `• <code>${a.id}</code> | <b>${a.ticker}</b> | ${a.type.toUpperCase()} | ${a.condition} ${a.value} (${statusSymbol} ${a.status})`
  })
  await sendTelegram([
    '<b>🔔 Alertas Configurados:</b>',
    '',
    ...lines
  ].join('\n'), chatId)
}

async function handleCreateAlert(chatId: number, args: string[]): Promise<void> {
  if (args.length < 4) {
    await sendTelegram([
      '⚠️ Uso incorreto. Sintaxe do comando:',
      '<code>/alerta [ativo] [tipo] [condição] [valor]</code>',
      '',
      'Tipos: <code>preco</code>, <code>rsi</code>, <code>sinal</code>',
      'Condições: <code>&gt;</code>, <code>&lt;</code>, <code>=</code>',
      'Exemplos:',
      '- <code>/alerta BTC-USD preco &gt; 70000</code>',
      '- <code>/alerta PETR4.SA rsi &lt; 30</code>',
      '- <code>/alerta VALE3.SA sinal = buy</code>'
    ].join('\n'), chatId)
    return
  }

  const ticker = args[0]!.toUpperCase().trim()
  const rawType = args[1]!.toLowerCase().trim()
  const rawCond = args[2]!.trim()
  const rawVal = args.slice(3).join(' ').toLowerCase().trim()

  // Validate type
  let type: 'price' | 'rsi' | 'ml_signal'
  if (rawType === 'preco' || rawType === 'price') {
    type = 'price'
  } else if (rawType === 'rsi') {
    type = 'rsi'
  } else if (rawType === 'sinal' || rawType === 'signal' || rawType === 'ml_signal') {
    type = 'ml_signal'
  } else {
    await sendTelegram(`⚠️ Tipo de alerta inválido: <code>${escapeHtml(rawType)}</code>. Use <code>preco</code>, <code>rsi</code> ou <code>sinal</code>.`, chatId)
    return
  }

  // Validate condition and value
  let condition: 'above' | 'below' | 'action_equals'
  let value: number | string

  if (type === 'price' || type === 'rsi') {
    if (rawCond === '>') {
      condition = 'above'
    } else if (rawCond === '<') {
      condition = 'below'
    } else {
      await sendTelegram(`⚠️ Condição inválida para tipo numérico: <code>${escapeHtml(rawCond)}</code>. Use <code>&gt;</code> ou <code>&lt;</code>.`, chatId)
      return
    }
    const numVal = parseFloat(rawVal)
    if (isNaN(numVal)) {
      await sendTelegram(`⚠️ Valor numérico inválido: <code>${escapeHtml(rawVal)}</code>.`, chatId)
      return
    }
    value = numVal
  } else {
    condition = 'action_equals'
    const targetVal = rawVal.replace('=', '').trim()
    if (targetVal !== 'buy' && targetVal !== 'sell' && targetVal !== 'hold') {
      await sendTelegram(`⚠️ Sinal de ML inválido: <code>${escapeHtml(targetVal)}</code>. Use <code>buy</code>, <code>sell</code> ou <code>hold</code>.`, chatId)
      return
    }
    value = targetVal
  }

  try {
    const alert = addAlert({
      ticker,
      type,
      condition,
      value
    })
    await sendTelegram(`✅ Alerta criado com sucesso!\nID: <code>${alert.id}</code>\nAtivo: <b>${alert.ticker}</b>\nCondição: ${alert.type.toUpperCase()} ${alert.condition} ${alert.value}`, chatId)
  } catch (err: any) {
    await sendTelegram(`⚠️ Erro ao criar alerta: ${escapeHtml(err.message)}`, chatId)
  }
}

async function handleDeleteAlert(chatId: number, id: string): Promise<void> {
  if (!id) {
    await sendTelegram('⚠️ Uso: <code>/delalerta [ID]</code>', chatId)
    return
  }
  const success = deleteAlert(id)
  if (success) {
    await sendTelegram(`✅ Alerta <code>${escapeHtml(id)}</code> removido com sucesso.`, chatId)
  } else {
    await sendTelegram(`⚠️ Alerta com ID <code>${escapeHtml(id)}</code> não encontrado.`, chatId)
  }
}

async function dispatch(chatId: number, text: string): Promise<void> {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/)
  const cmd = (cmdRaw || '').toLowerCase().replace(/@.*$/, '')
  const arg = normalizeTicker(rest.join(' '))

  try {
    switch (cmd) {
      case '/start':
      case '/ajuda':
      case '/help':
        await sendTelegram(HELP, chatId)
        break
      case '/radar':
        await sendTelegram('⏳ Montando radar...', chatId)
        await handleRadar(chatId)
        break
      case '/analise':
      case '/analyze':
        if (!arg) return void await sendTelegram('Uso: <code>/analise PETR4.SA</code>', chatId)
        await sendTelegram(`⏳ Analisando ${escapeHtml(arg)}...`, chatId)
        await handleAnalyze(chatId, arg)
        break
      case '/research':
        if (!arg) return void await sendTelegram('Uso: <code>/research BTC-USD</code>', chatId)
        await handleResearch(chatId, arg)
        break
      case '/predict':
        if (!arg) return void await sendTelegram('Uso: <code>/predict VALE3.SA</code>', chatId)
        await handlePredict(chatId, arg)
        break
      case '/alertas':
      case '/alerts':
        await handleListAlerts(chatId)
        break
      case '/alerta':
      case '/alert':
        await handleCreateAlert(chatId, rest)
        break
      case '/remover_alerta':
      case '/delalerta':
      case '/delalert':
        await handleDeleteAlert(chatId, rest[0] || '')
        break
      default:
        await sendTelegram(HELP, chatId)
    }
  } catch (error: any) {
    console.error(JSON.stringify({ level: 'error', message: 'bot dispatch failed', cmd, error: error.message }))
    await sendTelegram(`⚠️ Erro ao processar ${escapeHtml(cmd)}: ${escapeHtml(error.message || 'desconhecido')}`, chatId).catch(() => {})
  }
}

export async function startTelegramBot(): Promise<void> {
  if (!BOT_TOKEN) {
    console.log(JSON.stringify({ level: 'info', message: 'Telegram bot disabled (no TELEGRAM_BOT_TOKEN)' }))
    return
  }
  console.log(JSON.stringify({ level: 'info', message: 'Telegram bot started (long-polling)', allowedChat: ALLOWED_CHAT || 'any' }))
  let offset = 0
  // Long-polling loop. Cada getUpdates aguarda ate 50s por novas mensagens.
  for (;;) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=50&offset=${offset}`)
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 3000))
        continue
      }
      const json = await res.json() as any
      for (const update of json.result || []) {
        offset = update.update_id + 1
        const msg = update.message
        const text = msg?.text
        const chatId = msg?.chat?.id
        if (!text || chatId == null) continue
        if (ALLOWED_CHAT && String(chatId) !== ALLOWED_CHAT) {
          await sendTelegram('🚫 Chat não autorizado.', chatId).catch(() => {})
          continue
        }
        void dispatch(chatId, text)
      }
    } catch (error: any) {
      console.error(JSON.stringify({ level: 'error', message: 'getUpdates failed', error: error.message }))
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

if (import.meta.main) {
  await startTelegramBot()
}
