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
const resAnalysis = document.getElementById('res-analysis') as HTMLParagraphElement;

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;

  // Show loading
  loading.classList.remove('hidden');
  resultDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');
  btn.disabled = true;

  try {
    const response = await fetch('http://localhost:3000/api/analyze', {
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
  }
});
