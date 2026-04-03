import { Hono } from 'hono'
import { cors } from 'hono/cors'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()
import { Ollama } from 'ollama'

const app = new Hono()

app.use('*', cors())

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' })

app.get('/', (c) => {
  return c.text('B3 Stock Analyzer API')
})

app.get('/api/quote/:ticker', async (c) => {
  const ticker = c.req.param('ticker')
  try {
    const quote = await yahooFinance.quote(ticker)
    return c.json(quote)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/history/:ticker', async (c) => {
  const ticker = c.req.param('ticker')
  try {
    const queryOptions = { period1: '2023-01-01' } // Fetch from last year for more data
    const result = await yahooFinance.historical(ticker, queryOptions)
    return c.json(result)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/api/analyze', async (c) => {
  try {
    const { ticker } = await c.req.json()
    if (!ticker) {
      return c.json({ error: 'Ticker is required' }, 400)
    }

    // 1. Fetch recent stock data
    const quote = await yahooFinance.quote(ticker)

    // 2. Fetch some historical data (last 30 days roughly)
    const date = new Date();
    date.setDate(date.getDate() - 30);
    const period1Str = date.toISOString().split('T')[0];

    const chart = await yahooFinance.chart(ticker, { period1: period1Str })
    const history = chart.quotes;

    // 3. Prepare prompt for Ollama
    const prompt = `
    Você é um analista financeiro especialista no mercado brasileiro (B3).
    Ação: ${ticker}
    Preço Atual: ${quote.regularMarketPrice} ${quote.currency}
    Variação: ${quote.regularMarketChangePercent}%
    Volume: ${quote.regularMarketVolume}

    Resumo do histórico de 30 dias:
    ${history.map((h: any) => `Data: ${h.date.toISOString().split('T')[0]}, Fechamento: ${h.close}`).join('\n')}

    Por favor, com base nesses dados recentes, forneça uma breve análise sobre a tendência dessa ação e diga se é uma boa oportunidade para ganhar dinheiro a curto/médio prazo. Justifique. Responda em português.
    `

    // 4. Query Ollama (assuming 'llama3' or 'mistral' model is available)
    let aiResponse = "Ollama is not running locally or failed to connect.";
    try {
      const response = await ollama.generate({
        model: 'llama3', // You can change this to mistral or another available model
        prompt: prompt,
        stream: false
      });
      aiResponse = response.response;
    } catch (ollamaError: any) {
      console.warn("Ollama connection failed, returning fallback message:", ollamaError.message);
    }

    return c.json({
      ticker,
      quote: {
        price: quote.regularMarketPrice,
        change: quote.regularMarketChangePercent
      },
      analysis: aiResponse
    })

  } catch (error: any) {
    console.error(error);
    return c.json({ error: error.message }, 500)
  }
})

export default {
  port: 3000,
  fetch: app.fetch,
}