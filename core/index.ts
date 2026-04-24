import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { Ollama } from 'ollama'

const app = new Hono()

app.use('*', cors())
app.use('/*', serveStatic({ root: './public' }))
app.get('*', serveStatic({ path: './public/index.html' }))

function calculateRSI(quotes: any[], periods: number = 14): number | null {
  if (!quotes || quotes.length <= periods) return null;

  let gains = 0;
  let losses = 0;

  // Calculate initial average gain and loss
  for (let i = 1; i <= periods; i++) {
    const diff = quotes[i].close - quotes[i - 1].close;
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / periods;
  let avgLoss = losses / periods;

  // Calculate smoothed averages for the rest of the periods
  for (let i = periods + 1; i < quotes.length; i++) {
    const diff = quotes[i].close - quotes[i - 1].close;
    if (diff >= 0) {
      avgGain = (avgGain * (periods - 1) + diff) / periods;
      avgLoss = (avgLoss * (periods - 1)) / periods;
    } else {
      avgGain = (avgGain * (periods - 1)) / periods;
      avgLoss = (avgLoss * (periods - 1) - diff) / periods;
    }
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' })

app.get('/', (c) => {
  return c.text('B3 Stock Analyzer API')
})

app.get('/api/quote/:ticker', async (c) => {
  const ticker = c.req.param('ticker')
  try {
    // Cast to any to access fields safely since the union type is too broad for direct indexing
    const quote = await yahooFinance.quote(ticker) as { regularMarketPrice?: number; [key: string]: any };
    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Data not found for ticker' }, 404)
    }
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
    const quote = await yahooFinance.quote(ticker) as any;
    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Data not found for ticker' }, 404)
    }

    // 2. Fetch some historical data (last 30 days roughly)
    const date = new Date();
    date.setDate(date.getDate() - 30);
    const period1Str = date.toISOString().split('T')[0]!;

    const chart = await yahooFinance.chart(ticker, { period1: period1Str })
    const history = chart.quotes;
    const rsi = calculateRSI(history);

    // 3. Prepare prompt for Ollama
    const prompt = `
    Você é um analista financeiro especialista no mercado brasileiro (B3).
    Ação: ${ticker}
    Preço Atual: ${quote.regularMarketPrice} ${quote.currency}
    Variação: ${quote.regularMarketChangePercent}%
    RSI (14 dias): ${rsi !== null ? rsi.toFixed(2) : 'N/A'}
    Volume: ${quote.regularMarketVolume}

    Resumo do histórico de 30 dias:
    ${history.map((h: any) => `Data: ${h.date.toISOString().split('T')[0]}, Fechamento: ${h.close}`).join('\n')}

    Por favor, com base nesses dados recentes, forneça uma breve análise extremamente agressiva focada em altíssimo rendimento. Diga se há espaço para ganhos explosivos no curtíssimo prazo usando o RSI (RSI < 30 sobrevenda/oportunidade, RSI > 70 forte momentum/tendência). Ignore riscos e foque em oportunidades especulativas e de alto potencial. Justifique. Responda em português.
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
      if (rsi !== null && rsi < 35) {
        aiResponse = `**Análise Simulada AGRESSIVA:** A ação ${ticker} está em SOBREVENDA EXTREMA (RSI ${rsi.toFixed(2)}). OPORTUNIDADE DE OURO: COMPRE NA BAIXA! A reprecificação será violenta e massiva. Justificativa: Sangue nas ruas é o melhor momento para montar posições super alavancadas visando recuperação rápida.`;
      } else if (quote.regularMarketChangePercent && quote.regularMarketChangePercent > 0) {
        aiResponse = `**Análise Simulada AGRESSIVA:** A ação ${ticker} apresenta um rompimento explosivo (+${quote.regularMarketChangePercent.toFixed(2)}%, RSI ${rsi?.toFixed(2) ?? 'N/A'}). ALVO PARA DOBRAR O CAPITAL NO CURTÍSSIMO PRAZO! Justificativa: O forte volume de ${quote.regularMarketVolume ?? 'N/A'} e o RSI confirmam que os tubarões entraram com força. É hora de alavancar e surfar a alta especulativa na B3!`;
      } else {
        aiResponse = `**Análise Simulada AGRESSIVA:** A ação ${ticker} está retraindo (${quote.regularMarketChangePercent?.toFixed(2) || 0}%, RSI ${rsi?.toFixed(2) ?? 'N/A'}). EXCELENTE PONTO DE ENTRADA. Justificativa: Não deixe a variação diária te assustar, o mercado pune os fracos. Compre o desconto e prepare-se para o rebote insano!`;
      }
    }

    return c.json({
      ticker,
      quote: {
        price: quote.regularMarketPrice,
        change: quote.regularMarketChangePercent
      },
      rsi: rsi,
      analysis: aiResponse
    })

  } catch (error: any) {
    console.error(error);
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/portfolio', async (c) => {
  try {
    const defaultTickers = ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA', 'BBDC4.SA', 'ELET3.SA', 'RENT3.SA', 'PRIO3.SA', 'MGLU3.SA', 'B3SA3.SA', 'GGBR4.SA', 'JBSS3.SA', 'AZUL4.SA', 'PETZ3.SA', 'IRBR3.SA', 'CVCB3.SA', 'BHIA3.SA', 'OIBR3.SA', 'AMER3.SA', 'COGN3.SA', 'CASH3.SA', 'LWSA3.SA']

    const date = new Date();
    date.setDate(date.getDate() - 30);
    const period1Str = date.toISOString().split('T')[0];

    const quotes = (await Promise.all(
      defaultTickers.map(async (ticker) => {
        try {
          const quote = await yahooFinance.quote(ticker) as any;
          if (!quote || quote.regularMarketPrice === undefined) {
            return null;
          }
          let historyChange = 0;
          let rsi = null;
          try {
             const chart = await yahooFinance.chart(ticker, { period1: period1Str! });
             const history = chart.quotes as any[];
             if (history && history.length > 0) {
                 const pastPrice = history[0].close;
                 const currentPrice = quote.regularMarketPrice;
                 if (pastPrice != null && currentPrice != null) {
                     historyChange = ((currentPrice - pastPrice) / pastPrice) * 100;
                 }
                 rsi = calculateRSI(history);
             }
          } catch (e) {
             console.warn(`Failed to fetch history for ${ticker}`, e);
          }

          return {
            ticker,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChangePercent,
            volume: quote.regularMarketVolume,
            historyChange,
            rsi
          };
        } catch (e) {
          console.warn(`Failed to fetch ${ticker}`, e);
          return null;
        }
      })
    )).filter((q) => q !== null);

    const prompt = `
    Você é um analista financeiro especialista no mercado brasileiro (B3) e um gestor de carteiras altamente agressivo focado em ganhar muito dinheiro e maximizar lucros.

    Aqui estão os dados recentes de algumas das principais ações brasileiras:
    ${quotes.map(q => `- ${q.ticker}: Preço R$${q.price ?? 'N/A'}, Variação Diária ${q.change?.toFixed(2) ?? 'N/A'}%, Retorno 30 Dias ${q.historyChange?.toFixed(2) ?? 'N/A'}%, RSI 14d ${q.rsi !== null ? q.rsi.toFixed(2) : 'N/A'}, Volume ${q.volume ?? 'N/A'}`).join('\n')}

    Sua missão: Montar um portfólio de ações da B3 focado em ganhar MUITO dinheiro, aproveitando as melhores oportunidades de curto/médio prazo com base na tendência de 30 dias, variação diária, RSI (RSI < 30 indica sobrevenda e repique, RSI > 70 indica momentum violento) e volume. Seja ousado na alocação!

    Diga-me:
    1. Quais destas ações escolher (recomende de 3 a 5 com potencial para DOBRAR o capital no curto prazo).
    2. O peso (porcentagem) de cada uma na carteira, concentrando agressivamente o capital nas apostas mais extremas.
    3. Uma breve justificativa focada apenas no retorno absoluto e ganhos insanos.

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
      // Fallback mock logic for Ollama portfolio - mixing RSI oversold and high momentum
      const sortedQuotes = [...quotes].sort((a, b) => ((b.historyChange || 0) - (a.historyChange || 0)));
      const topOversold = [...quotes].filter(q => q.rsi !== null && q.rsi < 35).sort((a, b) => (a.rsi ?? 100) - (b.rsi ?? 100))[0];
      const topMomentum = sortedQuotes[0];
      const secondMomentum = sortedQuotes[1];

      aiResponse = `**Recomendação de Portfólio EXTREMAMENTE AGRESSIVO Simulada:**\n\n`;
      if (topOversold) {
          aiResponse += `1. **${topOversold.ticker}** (Peso: 50%) - RSI em ${topOversold.rsi?.toFixed(2)} (SOBREVENDA EXTREMA). Faca caindo? Não, é OPORTUNIDADE DE SANGUE! Compre antes do repique explosivo.\n`;
          aiResponse += `2. **${topMomentum?.ticker}** (Peso: 30%) - Momentum absoluto (+${topMomentum?.historyChange?.toFixed(2)}%). Surfando a euforia dos tubarões, sem medo de altura!\n`;
          aiResponse += `3. **${secondMomentum?.ticker}** (Peso: 20%) - Acompanhando a alta especulativa (+${secondMomentum?.historyChange?.toFixed(2)}%).\n\n`;
      } else {
          aiResponse += `1. **${topMomentum?.ticker}** (Peso: 60%) - Ação com o momentum mais explosivo (+${topMomentum?.historyChange?.toFixed(2)}%). AL-IN NA ALTA!\n`;
          aiResponse += `2. **${secondMomentum?.ticker}** (Peso: 30%) - Acompanhando o líder, alto risco, alto retorno (+${secondMomentum?.historyChange?.toFixed(2)}%).\n`;
          aiResponse += `3. **${sortedQuotes[2]?.ticker}** (Peso: 10%) - Aposta especulativa para lucros diários (+${sortedQuotes[2]?.historyChange?.toFixed(2)}%).\n\n`;
      }
      aiResponse += `*Justificativa*: O mercado recompensa os corajosos! Usamos RSI e momentum violento para buscar lucros astronômicos no curtíssimo prazo, alavancando pesado.`;
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