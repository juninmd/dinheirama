// Universo monitorado (ações líquidas da B3) com setor e marcação de instituições financeiras.
// Lista fixa e atual => viés de sobrevivência em backtests (declarado nas ressalvas).

export interface UniverseAsset {
  ticker: string
  name: string
  assetClass: 'stock'
  thesis: string
  sector: string
  isFinancial: boolean
}

const asset = (
  ticker: string,
  name: string,
  thesis: string,
  sector: string,
  isFinancial = false
): UniverseAsset => ({ ticker, name, assetClass: 'stock', thesis, sector, isFinancial })

export const MARKET_UNIVERSE: UniverseAsset[] = [
  asset('PETR4.SA', 'Petrobras PN', 'energia, petroleo e dividendos', 'Petróleo e gás'),
  asset('VALE3.SA', 'Vale ON', 'minerio, China e commodities', 'Mineração'),
  asset('ITUB4.SA', 'Itau Unibanco PN', 'banco, credito e juros', 'Bancos', true),
  asset('WEGE3.SA', 'WEG ON', 'industria, energia e crescimento global', 'Industrial'),
  asset('BBAS3.SA', 'Banco do Brasil ON', 'banco publico, dividendos e agro', 'Bancos', true),
  asset('BBDC4.SA', 'Bradesco PN', 'banco, turnaround e credito', 'Bancos', true),
  asset('RENT3.SA', 'Localiza ON', 'locacao, juros e mobilidade', 'Locação'),
  asset('PRIO3.SA', 'Prio ON', 'petroleo, producao e crescimento', 'Petróleo e gás'),
  asset('MGLU3.SA', 'Magazine Luiza ON', 'varejo, ecommerce e juros', 'Varejo'),
  asset('B3SA3.SA', 'B3 ON', 'bolsa, volume financeiro e mercado de capitais', 'Mercado de capitais', true),
  asset('GGBR4.SA', 'Gerdau PN', 'aco, ciclo industrial e commodities', 'Siderurgia'),
  asset('JBSS3.SA', 'JBS ON', 'proteina global, cambio e margens', 'Alimentos'),
  asset('TOTS3.SA', 'TOTVS ON', 'software, recorrencia e margens', 'Tecnologia'),
  asset('RADL3.SA', 'Raia Drogasil ON', 'saude, varejo defensivo e expansao', 'Saúde'),
  asset('VIVT3.SA', 'Telefonica Brasil ON', 'telecom, dividendos e defensivo', 'Telecom'),
  asset('TAEE11.SA', 'Taesa Unit', 'transmissao, dividendos e inflacao', 'Energia elétrica'),
  asset('SUZB3.SA', 'Suzano ON', 'papel, celulose e dolar', 'Papel e celulose'),
  asset('EQTL3.SA', 'Equatorial ON', 'energia, crescimento e turnaround', 'Energia elétrica'),
  asset('CSNA3.SA', 'CSN ON', 'siderurgia, minerio e commodities', 'Siderurgia'),
  asset('LREN3.SA', 'Lojas Renner ON', 'varejo de moda e consumo', 'Varejo'),
  asset('BBSE3.SA', 'BB Seguridade ON', 'seguros, agro e dividendos', 'Seguros', true),
  asset('CMIG4.SA', 'Cemig PN', 'energia, estatal e dividendos', 'Energia elétrica'),
  asset('CPLE6.SA', 'Copel PNB', 'energia, privatizacao e turnaround', 'Energia elétrica'),
  asset('CYRE3.SA', 'Cyrela ON', 'construcao civil e juros', 'Construção'),
  asset('ELET3.SA', 'Eletrobras ON', 'energia, privatizacao e eficiencia', 'Energia elétrica'),
  asset('SBSP3.SA', 'Sabesp ON', 'saneamento, privatizacao e dividendos', 'Saneamento'),
  asset('ASAI3.SA', 'Assai ON', 'varejo alimentar e expansao', 'Varejo'),
  asset('NTCO3.SA', 'Natura ON', 'cosmeticos, reestruturacao e consumo', 'Consumo'),
  asset('HAPV3.SA', 'Hapvida ON', 'saude, sinergias e crescimento', 'Saúde'),
]

export const SECTOR_BY_TICKER: Record<string, string> = Object.fromEntries(MARKET_UNIVERSE.map(a => [a.ticker, a.sector]))
export const FINANCIAL_TICKERS = new Set(MARKET_UNIVERSE.filter(a => a.isFinancial).map(a => a.ticker))
