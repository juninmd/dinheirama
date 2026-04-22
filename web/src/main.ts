import './style.css'

const form = document.getElementById('analyze-form') as HTMLFormElement;
const input = document.getElementById('ticker-input') as HTMLInputElement;
const btn = document.getElementById('analyze-btn') as HTMLButtonElement;
const loading = document.getElementById('loading') as HTMLDivElement;
const resultDiv = document.getElementById('result') as HTMLDivElement;
const errorDiv = document.getElementById('error') as HTMLDivElement;

const resTicker = document.getElementById('res-ticker') as HTMLSpanElement;
const resPrice = document.getElementById('res-price') as HTMLSpanElement;
const resChange = document.getElementById('res-change') as HTMLSpanElement;
const resRsi = document.getElementById('res-rsi') as HTMLSpanElement;
const resAnalysis = document.getElementById('res-analysis') as HTMLParagraphElement;

const generatePortfolioBtn = document.getElementById('generate-portfolio-btn') as HTMLButtonElement;
const portfolioResultDiv = document.getElementById('portfolio-result') as HTMLDivElement;
const portfolioStats = document.getElementById('portfolio-stats') as HTMLDivElement;
const portfolioAnalysis = document.getElementById('portfolio-analysis') as HTMLParagraphElement;

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;

  // Show loading
  loading.classList.remove('hidden');
  resultDiv.classList.add('hidden');
  portfolioResultDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');
  btn.disabled = true;
  generatePortfolioBtn.disabled = true;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ticker })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao analisar a ação');
    }

    // Populate results
    resTicker.textContent = data.ticker;
    resPrice.textContent = `R$ ${data.quote.price.toFixed(2)}`;
    resChange.textContent = data.quote.change.toFixed(2);
    resRsi.textContent = data.rsi !== null ? data.rsi.toFixed(2) : 'N/A';

    // Simple parsing for newlines from markdown response
    resAnalysis.innerHTML = data.analysis.replace(/\n/g, '<br/>');

    // Show results
    resultDiv.classList.remove('hidden');

  } catch (error: any) {
    errorDiv.textContent = `Erro: ${error.message}`;
    errorDiv.classList.remove('hidden');
  } finally {
    loading.classList.add('hidden');
    btn.disabled = false;
    generatePortfolioBtn.disabled = false;
  }
});

generatePortfolioBtn.addEventListener('click', async () => {
  // Show loading
  loading.classList.remove('hidden');
  resultDiv.classList.add('hidden');
  portfolioResultDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');
  btn.disabled = true;
  generatePortfolioBtn.disabled = true;

  try {
    const response = await fetch('/api/portfolio', {
      method: 'GET'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao gerar portfólio');
    }

    // Populate portfolio stats
    portfolioStats.innerHTML = '';
    data.portfolio.forEach((stock: any) => {
      const p = document.createElement('p');
      const histChange = stock.historyChange !== undefined && stock.historyChange !== null ? stock.historyChange.toFixed(2) : 'N/A';
      const rsiDisplay = stock.rsi !== undefined && stock.rsi !== null ? stock.rsi.toFixed(2) : 'N/A';
      p.innerHTML = `<strong>${stock.ticker}</strong>: R$ ${(stock.price ?? 0).toFixed(2)} (Dia: ${(stock.change ?? 0).toFixed(2)}% | 30D: ${histChange}% | RSI: ${rsiDisplay})`;
      portfolioStats.appendChild(p);
    });

    // Simple parsing for newlines from markdown response
    portfolioAnalysis.style.whiteSpace = 'pre-wrap';
    portfolioAnalysis.textContent = data.recommendation;

    // Show results
    portfolioResultDiv.classList.remove('hidden');

  } catch (error: any) {
    errorDiv.textContent = `Erro: ${error.message}`;
    errorDiv.classList.remove('hidden');
  } finally {
    loading.classList.add('hidden');
    btn.disabled = false;
    generatePortfolioBtn.disabled = false;
  }
});
