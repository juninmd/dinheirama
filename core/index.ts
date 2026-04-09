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

    Por favor, com base nesses dados recentes, forneça uma breve análise extremamente agressiva focada em altíssimo rendimento. Diga se há espaço para ganhos explosivos no curtíssimo prazo. Ignore riscos e foque em oportunidades especulativas e de alto potencial. Justifique. Responda em português.
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
        aiResponse = '**Análise Simulada AGRESSIVA:** A ação ' + ticker + ' apresenta um rompimento explosivo (+' + quote.regularMarketChangePercent.toFixed(2) + '%). ALVO PARA DOBRAR O CAPITAL NO CURTÍSSIMO PRAZO! Justificativa: O forte volume de ' + (quote.regularMarketVolume ?? 'N/A') + ' mostra os tubarões entrando com força. É hora de alavancar e surfar a alta especulativa na B3!';
      } else {
        aiResponse = `**Análise Simulada AGRESSIVA:** A ação ${ticker} está sangrando e com desconto brutal (${quote.regularMarketChangePercent?.toFixed(2) || 0}%). OPORTUNIDADE DE OURO: COMPRE NA BAIXA! O repique será massivo. Justificativa: Sangue nas ruas é o melhor momento para montar posições super alavancadas visando recuperação rápida.`;
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
    const defaultTickers = ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA', 'BBDC4.SA', 'ELET3.SA', 'RENT3.SA', 'PRIO3.SA', 'MGLU3.SA', 'B3SA3.SA', 'GGBR4.SA', 'JBSS3.SA', 'AZUL4.SA', 'PETZ3.SA', 'IRBR3.SA', 'CVCB3.SA', 'BHIA3.SA']

    const date = new Date();
    date.setDate(date.getDate() - 30);
    const period1Str = date.toISOString().split('T')[0];

    const quotes = (await Promise.all(
      defaultTickers.map(async (ticker) => {
        try {
          const quote = await yahooFinance.quote(ticker);
          let historyChange = 0;
          try {
             const chart = await yahooFinance.chart(ticker, { period1: period1Str });
             const history = chart.quotes;
             if (history && history.length > 0) {
                 const pastPrice = history[0].close;
                 const currentPrice = quote.regularMarketPrice;
                 if (pastPrice && currentPrice) {
                     historyChange = ((currentPrice - pastPrice) / pastPrice) * 100;
                 }
             }
          } catch (e) {
             console.warn(`Failed to fetch history for ${ticker}`, e);
          }

          return {
            ticker,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChangePercent,
            volume: quote.regularMarketVolume,
            historyChange
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
    ${quotes.map(q => `- ${q.ticker}: Preço R$${q.price ?? 'N/A'}, Variação Diária ${q.change?.toFixed(2) ?? 'N/A'}%, Retorno 30 Dias ${q.historyChange?.toFixed(2) ?? 'N/A'}%, Volume ${q.volume ?? 'N/A'}`).join('\n')}

    Sua missão: Montar um portfólio de ações da B3 focado em ganhar MUITO dinheiro, aproveitando as melhores oportunidades de curto/médio prazo com base APENAS na tendência de 30 dias, variação diária e volume. Seja ousado na alocação!

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
      // Fallback mock logic for Ollama portfolio - sorting by 30-day history change for aggressive momentum
      const sortedQuotes = [...quotes].sort((a, b) => ((b.historyChange || 0) - (a.historyChange || 0)));
      const top3 = sortedQuotes.slice(0, 3);
      aiResponse = `**Recomendação de Portfólio EXTREMAMENTE AGRESSIVO Simulada:**

1. **${top3[0]?.ticker}** (Peso: 60%) - Ação com o momentum mais explosivo nos últimos 30 dias (+${top3[0]?.historyChange?.toFixed(2)}%). AL-IN NA ALTA!
2. **${top3[1]?.ticker}** (Peso: 30%) - Acompanhando o líder de perto, alto risco, alto retorno (+${top3[1]?.historyChange?.toFixed(2)}%).
3. **${top3[2]?.ticker}** (Peso: 10%) - Aposta especulativa para dar um boost nos lucros diários (+${top3[2]?.historyChange?.toFixed(2)}%).

*Justificativa*: O mercado recompensa os corajosos! Esta carteira descarta qualquer noção de segurança e aposta 100% no momentum mais violento do último mês para buscar lucros astronômicos no curtíssimo prazo.`;
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