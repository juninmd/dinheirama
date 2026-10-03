// IA com limites: o LLM só EXPLICA números já calculados. Qualquer número na resposta que não exista
// na ficha de fatos, ou frases de certeza/promessa, derrubam a resposta e usa-se o texto determinístico.

import type { Llm } from '../llm.ts'

export interface FactLine {
  label: string
  /** Texto exibido ao modelo. */
  display: string
  /** Valores numéricos legítimos associados (fração, percentual, bruto...). */
  numbers?: number[]
}

export const DISCLAIMER = 'Projeto pessoal e educacional; não é recomendação de investimento.'

const FORBIDDEN = [
  /garantid[oa]/i, /sem risco/i, /certeza/i, /compre agora/i, /vai subir/i, /vai cair/i, /lucro certo/i,
  /imperd[ií]vel/i, /n[ãa]o tem como perder/i, /retorno assegurado/i, /dinheiro f[aá]cil/i,
]

/** Extrai números de texto em pt-BR/en (1.234,56 | 12,5% | 3.5x | -4%). */
export function extractNumbers(text: string): number[] {
  const out: number[] = []
  const re = /-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:[.,]\d+)?/g
  for (const match of text.matchAll(re)) {
    let raw = match[0]
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) raw = raw.replace(/\./g, '').replace(',', '.')
    else raw = raw.replace(',', '.')
    const value = Number(raw)
    if (Number.isFinite(value)) out.push(value)
  }
  return out
}

/** Gera variantes aceitáveis de cada número da ficha (fração↔percentual, arredondamentos). */
export function allowedNumbers(facts: FactLine[]): number[] {
  const out = new Set<number>()
  const add = (v: number) => {
    if (!Number.isFinite(v)) return
    for (const d of [0, 1, 2, 3]) out.add(Number(v.toFixed(d)))
    out.add(v)
  }
  for (const fact of facts) {
    for (const v of fact.numbers ?? []) {
      add(v)
      add(Math.abs(v))
      add(v * 100)
      add(Math.abs(v * 100))
    }
    for (const v of extractNumbers(fact.display)) {
      add(v)
      add(Math.abs(v))
    }
  }
  return Array.from(out)
}

function isIgnorable(value: number): boolean {
  // numeração de listas/pequenos inteiros e anos não são afirmações quantitativas
  if (Number.isInteger(value) && value >= 0 && value <= 10) return true
  if (Number.isInteger(value) && value >= 1990 && value <= 2100) return true
  return false
}

export interface ValidationResult {
  ok: boolean
  unsupportedNumbers: number[]
  forbidden: string[]
}

export function validateExplanation(text: string, facts: FactLine[]): ValidationResult {
  const allowed = allowedNumbers(facts)
  const unsupported: number[] = []
  extractNumbers(text).forEach(value => {
    if (isIgnorable(value)) return
    const matches = allowed.some(a => Math.abs(a - value) <= Math.max(0.051, Math.abs(a) * 0.015))
    if (!matches) unsupported.push(value)
  })
  const forbidden = FORBIDDEN.filter(re => re.test(text)).map(re => re.source)
  return { ok: unsupported.length === 0 && forbidden.length === 0, unsupportedNumbers: unsupported, forbidden }
}

/** Prompt restritivo: o modelo recebe só os fatos e regras claras de não inventar. */
export function buildGuardedPrompt(subject: string, facts: FactLine[]): string {
  return [
    'Você explica resultados de um modelo quantitativo educacional de ações da B3, em português do Brasil.',
    'REGRAS OBRIGATÓRIAS:',
    '- Use SOMENTE os fatos listados abaixo. Não cite nenhum número que não esteja na lista.',
    '- Não invente notícias, preços-alvo, datas, resultados de empresas ou previsões.',
    '- Não use linguagem de certeza ou promessa ("garantido", "vai subir", "sem risco").',
    '- Explique em até 6 linhas o que os números sugerem, os riscos e o que NÃO sabemos.',
    `- Termine com: "${DISCLAIMER}"`,
    '',
    `ASSUNTO: ${subject}`,
    'FATOS:',
    ...facts.map(f => `- ${f.label}: ${f.display}`),
  ].join('\n')
}

export interface GuardedResult {
  text: string
  source: 'llm' | 'template'
  rejected?: ValidationResult
}

/** Chama o LLM com restrições; se a resposta falhar na validação (ou o LLM falhar), usa o fallback. */
export async function guardedExplain(
  llm: Llm | null,
  subject: string,
  facts: FactLine[],
  fallback: string
): Promise<GuardedResult> {
  const withDisclaimer = (text: string) => (text.includes(DISCLAIMER) ? text : `${text}\n\n_${DISCLAIMER}_`)
  if (!llm) return { text: withDisclaimer(fallback), source: 'template' }
  try {
    const raw = await llm.generate(buildGuardedPrompt(subject, facts))
    const verdict = validateExplanation(raw, facts)
    if (verdict.ok) return { text: withDisclaimer(raw), source: 'llm' }
    return { text: withDisclaimer(fallback), source: 'template', rejected: verdict }
  } catch {
    return { text: withDisclaimer(fallback), source: 'template' }
  }
}
