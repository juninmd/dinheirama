import './style.css'

interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
  duration: number
}

interface WatchlistItem {
  ticker: string
  addedAt: number
  price?: number
  change?: number
}

interface AnalyzeResponse {
  ticker: string
  quote: { price: number; change: number; volume?: number; currency?: string }
  rsi: number | null
  analysis: string
  aiSource: string
  timestamp: string
}

interface PortfolioResponse {
  portfolio: Array<{
    ticker: string
    price: number
    change: number
    historyChange: number
    rsi: number | null
  }>
  recommendation: string
  aiSource: string
  tickersAnalyzed: number
  timestamp: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const form = $<HTMLFormElement>('analyze-form')
const input = $<HTMLInputElement>('ticker-input')
const btn = $<HTMLButtonElement>('analyze-btn')
const loading = $<HTMLDivElement>('loading')
const resultDiv = $<HTMLDivElement>('result')
const errorDiv = $<HTMLDivElement>('error')
const generatePortfolioBtn = $<HTMLButtonElement>('generate-portfolio-btn')
const portfolioResultDiv = $<HTMLDivElement>('portfolio-result')
const portfolioStats = $<HTMLDivElement>('portfolio-stats')
const portfolioAnalysis = $<HTMLParagraphElement>('portfolio-analysis')
const networkStatus = $<HTMLDivElement>('network-status')
const watchlistContainer = $<HTMLDivElement>('watchlist-container')
const watchlistList = $<HTMLUListElement>('watchlist-list')
const darkModeToggle = $<HTMLButtonElement>('dark-mode-toggle')
const toastContainer = $<HTMLDivElement>('toast-container')

let isOnline = navigator.onLine
let toastTimeout: ReturnType<typeof setTimeout> | null = null

function initApp(): void {
  loadDarkModePreference()
  loadWatchlist()
  setupNetworkListeners()
  setupKeyboardShortcuts()
}

function loadDarkModePreference(): void {
  const saved = localStorage.getItem('darkMode')
  if (saved === 'true' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.setAttribute('data-theme', 'light')
  }
}

function loadWatchlist(): void {
  try {
    const saved = localStorage.getItem('dinheirama_watchlist')
    if (saved) {
      const items: WatchlistItem[] = JSON.parse(saved)
      renderWatchlist(items)
    }
  } catch {
    console.warn('Failed to load watchlist')
  }
}

function saveWatchlist(items: WatchlistItem[]): void {
  localStorage.setItem('dinheirama_watchlist', JSON.stringify(items))
}

function renderWatchlist(items: WatchlistItem[]): void {
  if (items.length === 0) {
    watchlistContainer.classList.add('hidden')
    return
  }

  watchlistContainer.classList.remove('hidden')
  watchlistList.innerHTML = ''

  items.forEach(item => {
    const li = document.createElement('li')
    li.className = 'watchlist-item'
    li.innerHTML = `
      <span class="watchlist-ticker">${item.ticker}</span>
      <button class="watchlist-remove" data-ticker="${item.ticker}" aria-label="Remove ${item.ticker}">×</button>
    `

    li.querySelector('.watchlist-remove')?.addEventListener('click', () => {
      removeFromWatchlist(item.ticker)
    })

    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('watchlist-remove')) return
      analyzeFromWatchlist(item.ticker)
    })

    watchlistList.appendChild(li)
  })
}

function addToWatchlist(ticker: string): void {
  const saved = localStorage.getItem('dinheirama_watchlist')
  const items: WatchlistItem[] = saved ? JSON.parse(saved) : []

  if (items.some(i => i.ticker === ticker)) {
    showToast(`${ticker} já está na watchlist`, 'info')
    return
  }

  items.unshift({ ticker, addedAt: Date.now() })
  if (items.length > 10) items.pop()

  saveWatchlist(items)
  renderWatchlist(items)
  showToast(`${ticker} adicionada à watchlist`, 'success')
}

function removeFromWatchlist(ticker: string): void {
  const saved = localStorage.getItem('dinheirama_watchlist')
  if (!saved) return

  const items: WatchlistItem[] = JSON.parse(saved)
  const filtered = items.filter(i => i.ticker !== ticker)

  saveWatchlist(filtered)
  renderWatchlist(filtered)
  showToast(`${ticker} removida da watchlist`, 'info')
}

function setupNetworkListeners(): void {
  window.addEventListener('online', () => {
    isOnline = true
    networkStatus.classList.add('hidden')
    showToast('Conexão restaurada', 'success')
  })

  window.addEventListener('offline', () => {
    isOnline = false
    networkStatus.classList.remove('hidden')
    networkStatus.innerHTML = '⚠️ Você está offline. Algumas funcionalidades podem não funcionar.'
    showToast('Conexão perdida', 'error')
  })
}

function setupKeyboardShortcuts(): void {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      form.dispatchEvent(new Event('submit'))
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideAllResults()
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      input.focus()
      input.select()
    }
  })
}

function showToast(message: string, type: Toast['type'] = 'info', duration = 4000): void {
  if (toastTimeout) clearTimeout(toastTimeout)

  const toast: Toast = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type,
    message,
    duration
  }

  const toastEl = document.createElement('div')
  toastEl.className = `toast toast-${toast.type}`
  toastEl.innerHTML = `
    <span class="toast-icon">${getToastIcon(type)}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Fechar">×</button>
  `

  toastEl.querySelector('.toast-close')?.addEventListener('click', () => removeToast(toast.id))
  toastContainer.appendChild(toastEl)

  requestAnimationFrame(() => toastEl.classList.add('show'))

  toastTimeout = setTimeout(() => removeToast(toast.id), duration)
}

function removeToast(id: string): void {
  const toastEl = toastContainer.querySelector(`[class^="toast"][id="${id}"]`) ||
    Array.from(toastContainer.children).find(c => c.children[1]?.textContent?.includes(id)) as HTMLElement

  if (toastEl) {
    toastEl.classList.remove('show')
    setTimeout(() => toastEl.remove(), 300)
  }
}

function getToastIcon(type: Toast['type']): string {
  const icons: Record<Toast['type'], string> = {
    success: '✓',
    error: '✗',
    info: 'ℹ',
    warning: '⚠'
  }
  return icons[type]
}

function setLoading(isLoading: boolean, message = 'Processando...'): void {
  if (isLoading) {
    resultDiv.classList.add('hidden')
    portfolioResultDiv.classList.add('hidden')
    errorDiv.classList.add('hidden')
    btn.disabled = true
    generatePortfolioBtn.disabled = true
  } else {
    btn.disabled = false
    generatePortfolioBtn.disabled = false
  }

  const loadingText = isLoading ? message : 'Processando...'
  loading.innerHTML = `
    <div class="spinner-container">
      <div class="spinner"></div>
      <p class="loading-text">${loadingText}</p>
    </div>
  `
  loading.classList.toggle('hidden', !isLoading)
}

function hideAllResults(): void {
  resultDiv.classList.add('hidden')
  portfolioResultDiv.classList.add('hidden')
  errorDiv.classList.add('hidden')
  loading.classList.add('hidden')
}

function formatPrice(value: number | undefined | null, decimals = 2): string {
  if (value == null) return 'N/A'
  return `R$ ${value.toFixed(decimals)}`
}

function formatPercent(value: number | undefined | null, decimals = 2): string {
  if (value == null) return 'N/A'
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

function getRSIColor(rsi: number | null): string {
  if (rsi == null) return 'var(--text-muted)'
  if (rsi < 30) return 'var(--success)'
  if (rsi > 70) return 'var(--danger)'
  return 'var(--warning)'
}

function getChangeColor(change: number | undefined | null): string {
  if (change == null) return 'var(--text-muted)'
  if (change >= 0) return 'var(--success)'
  return 'var(--danger)'
}

function renderAnalysisResult(data: AnalyzeResponse): void {
  const resTicker = $<HTMLSpanElement>('res-ticker')
  const resPrice = $<HTMLSpanElement>('res-price')
  const resChange = $<HTMLSpanElement>('res-change')
  const resRsi = $<HTMLSpanElement>('res-rsi')
  const resAnalysis = $<HTMLParagraphElement>('res-analysis')
  const resAiSource = $<HTMLSpanElement>('res-ai-source')
  const addToWatchlistBtn = $<HTMLButtonElement>('add-to-watchlist-btn')

  resTicker.textContent = data.ticker
  resPrice.textContent = formatPrice(data.quote.price)
  resChange.textContent = formatPercent(data.quote.change)
  resChange.style.color = getChangeColor(data.quote.change)
  resRsi.textContent = data.rsi !== null ? data.rsi.toFixed(2) : 'N/A'
  resRsi.style.color = getRSIColor(data.rsi)

  resAnalysis.innerHTML = data.analysis
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')

  if (resAiSource) {
    resAiSource.textContent = data.aiSource === 'ollama' ? '🤖 IA' : '📊 Automático'
  }

  if (addToWatchlistBtn) {
    addToWatchlistBtn.onclick = () => addToWatchlist(data.ticker)
    addToWatchlistBtn.classList.remove('hidden')
  }

  resultDiv.classList.remove('hidden')
}

function renderPortfolioResult(data: PortfolioResponse): void {
  portfolioStats.innerHTML = ''

  const topStocks = data.portfolio
    .filter(s => s.rsi !== null)
    .sort((a, b) => (a.rsi ?? 50) - (b.rsi ?? 50))
    .slice(0, 6)

  topStocks.forEach(stock => {
    const div = document.createElement('div')
    div.className = 'portfolio-stock-card'
    div.innerHTML = `
      <div class="portfolio-stock-header">
        <span class="portfolio-stock-ticker">${stock.ticker}</span>
        <span class="portfolio-stock-price">${formatPrice(stock.price)}</span>
      </div>
      <div class="portfolio-stock-stats">
        <span style="color: ${getChangeColor(stock.change)}">${formatPercent(stock.change)}</span>
        <span style="color: ${getChangeColor(stock.historyChange)}">30D: ${formatPercent(stock.historyChange)}</span>
        <span style="color: ${getRSIColor(stock.rsi)}">RSI: ${stock.rsi?.toFixed(0) || 'N/A'}</span>
      </div>
    `
    portfolioStats.appendChild(div)
  })

  portfolioAnalysis.innerHTML = data.recommendation
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')

  portfolioResultDiv.classList.remove('hidden')
}

function showError(message: string, code?: string): void {
  let displayMessage = message

  if (code === 'NETWORK_ERROR') {
    displayMessage = 'Erro de conexão. Verifique sua internet.'
  } else if (code === 'TIMEOUT') {
    displayMessage = 'Tempo esgotado. Tente novamente.'
  } else if (code === 'INVALID_TICKER') {
    displayMessage = 'Ticker inválido. Use formato: PETR4.SA, VALE3.SA'
  } else if (code === 'NOT_FOUND') {
    displayMessage = 'Ação não encontrada. Verifique o ticker.'
  }

  errorDiv.innerHTML = `
    <span class="error-icon">⚠️</span>
    <span class="error-message">${displayMessage}</span>
  `
  errorDiv.classList.remove('hidden')

  if (code) {
    console.error(`Error [${code}]:`, message)
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 2,
  delayMs = 1000
): Promise<Response> {
  let lastError: Error | null = null

  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options)

      if (!response.ok && response.status >= 500 && i < retries) {
        throw new Error(`Server error: ${response.status}`)
      }

      return response
    } catch (error) {
      lastError = error as Error

      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)))
      }
    }
  }

  throw lastError
}

function analyzeFromWatchlist(ticker: string): void {
  input.value = ticker
  form.dispatchEvent(new Event('submit'))
}

darkModeToggle?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme')
  const next = current === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('darkMode', next === 'dark' ? 'true' : 'false')
  showToast(`Modo ${next === 'dark' ? 'escuro' : 'claro'} ativado`, 'info', 2000)
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()

  const ticker = input.value.trim().toUpperCase()

  if (!ticker) {
    showToast('Digite um ticker para analisar', 'warning')
    input.focus()
    return
  }

  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  setLoading(true, 'Analisando ação com IA...')

  try {
    const response = await fetchWithRetry('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker })
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao analisar ação')
    }

    renderAnalysisResult(data)
    showToast(`${ticker} analisada com sucesso`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'ANALYSIS_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

generatePortfolioBtn.addEventListener('click', async () => {
  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  setLoading(true, 'Analisando ações da B3...')

  try {
    const response = await fetchWithRetry('/api/portfolio', {
      method: 'GET'
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao gerar portfólio')
    }

    renderPortfolioResult(data)
    showToast(`Portfólio gerado (${data.tickersAnalyzed} ações)`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'PORTFOLIO_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

initApp()