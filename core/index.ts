import { Hono } from 'hono'
import { cors } from 'hono/cors'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
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
    let aiResponse = "";
    try {
      const response = await ollama.generate({
        model: 'llama3', // You can change this to mistral or another available model
        prompt: prompt,
        stream: false
      });
      aiResponse = response.response;
    } catch (ollamaError: any) {
      console.warn("Ollama connection failed, returning fallback message:", ollamaError.message);
      // Fallback mock logic for Ollama
      if (quote.regularMarketChangePercent && quote.regularMarketChangePercent > 0) {
        aiResponse = '**Análise Simulada:** A ação ' + ticker + ' apresenta tendência de alta recente (+' + quote.regularMarketChangePercent.toFixed(2) + '%). É uma boa oportunidade a curto/médio prazo. Justificativa: O volume de ' + (quote.regularMarketVolume ?? 'N/A') + ' reforça a pressão compradora e a força do ativo no atual cenário da B3.';
      } else {
        aiResponse = `**Análise Simulada:** A ação ${ticker} apresenta queda recente ou estabilidade (${quote.regularMarketChangePercent?.toFixed(2) || 0}%). Recomenda-se cautela ou aguardar melhor ponto de entrada no curto prazo. Justificativa: O mercado mostra pressão vendedora atual.`;
      }
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

app.get('/api/portfolio', async (c) => {
  try {
    const defaultTickers = ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA', 'BBDC4.SA', 'ELET3.SA', 'RENT3.SA']
    const quotes = (await Promise.all(
      defaultTickers.map(async (ticker) => {
        try {
          const quote = await yahooFinance.quote(ticker);
          return {
            ticker,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChangePercent,
            volume: quote.regularMarketVolume
          };
        } catch (e) {
          console.warn(`Failed to fetch ${ticker}`, e);
          return null;
        }
      })
    )).filter((q) => q !== null);

    const prompt = `
    Você é um analista financeiro especialista no mercado brasileiro (B3) e um gestor de carteiras experiente focado em maximizar lucros.

    Aqui estão os dados recentes de algumas das principais ações brasileiras:
    ${quotes.map(q => `- ${q.ticker}: Preço R$${q.price ?? 'N/A'}, Variação ${q.change?.toFixed(2) ?? 'N/A'}%, Volume ${q.volume ?? 'N/A'}`).join('\n')}

    Com base APENAS nestes dados de mercado acima (variação e volume) e em seu conhecimento sobre essas empresas sólidas, monte uma recomendação de portfólio diversificado.
    Diga-me:
    1. Quais destas ações escolher (recomende umas 3 a 5).
    2. O peso (porcentagem) de cada uma na carteira.
    3. Uma breve justificativa para as escolhas focada em potencial de ganho.

    Responda em formato Markdown, em português.
    `

    let aiResponse = "";
    try {
      const response = await ollama.generate({
        model: 'llama3',
        prompt: prompt,
        stream: false
      });
      aiResponse = response.response;
    } catch (ollamaError: any) {
      console.warn("Ollama connection failed, returning fallback message:", ollamaError.message);
      // Fallback mock logic for Ollama portfolio
      const sortedQuotes = [...quotes].sort((a, b) => ((b.change || 0) - (a.change || 0)));
      const top3 = sortedQuotes.slice(0, 3);
      aiResponse = `**Recomendação de Portfólio Simulada (Gestor IA):**

1. **${top3[0]?.ticker}** (Peso: 40%) - O ativo com a melhor variação recente. Oferece o maior potencial de alavancagem na carteira.
2. **${top3[1]?.ticker}** (Peso: 30%) - Excelente força compradora secundária para manter a rentabilidade equilibrada.
3. **${top3[2]?.ticker}** (Peso: 30%) - Para compor os últimos terços da carteira visando diversificação sem perder foco no ganho.

*Justificativa*: Com base na falta de conexão do LLM local, esta recomendação de emergência seleciona puramente os 3 ativos com maior variação positiva no dia de hoje para priorizar alocação tática no momentum.`;
    }

    return c.json({
      portfolio: quotes,
      recommendation: aiResponse
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