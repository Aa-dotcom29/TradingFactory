'use strict';

// Rule-based sentiment / severity / entity lexicon. The core pipeline must never depend
// on an LLM, so this file is the scoring backbone. Everything here is data, not logic, so
// it can be tuned without touching the workers.

// Weighted terms: positive weight raises the bullish score, negative lowers it.
const SENTIMENT_TERMS = [
  // bullish
  [/\bbeats?\b|\bbeat estimates\b/i, 2.0],
  [/\bprofit (up|jump|surge|soar|rise)/i, 1.8],
  [/\brecord (profit|revenue|high)/i, 1.8],
  [/\bstrong (results|earnings|growth|guidance|demand)/i, 1.6],
  [/\b(order win|wins order|bags order|new order|contract win)/i, 1.7],
  [/\b(upgrade|upgraded|raise target|raises target|outperform|buy rating)/i, 1.6],
  [/\b(expansion|capacity addition|new plant|acquisition|merger approved)/i, 1.1],
  [/\b(dividend|bonus issue|buyback)/i, 1.0],
  [/\b(surges?|rall(y|ies)|jumps?|soars?|gains?)\b/i, 1.4],
  [/\b(52[- ]week high|all[- ]time high)/i, 1.3],
  [/\b(positive|optimistic|upbeat) (outlook|guidance|cues)/i, 1.2],
  // bearish
  [/\bmiss(es|ed)?\b|\bmisses estimates\b/i, -2.0],
  [/\bprofit (down|fall|slump|plunge|decline|drop)/i, -1.8],
  [/\b(weak|disappointing) (results|earnings|growth|guidance|demand)/i, -1.6],
  [/\b(downgrade|downgraded|cut target|lower target|underperform|sell rating)/i, -1.6],
  [/\b(probe|investigation|raid|search by|enforcement action|notice from)/i, -1.7],
  [/\b(penalty|fine|fined|penalised|penalized)/i, -1.4],
  [/\b(fraud|scam|irregularit|misappropriat|embezzle)/i, -2.4],
  [/\b(default|insolvency|bankrupt|nclt|resolution professional)/i, -2.4],
  [/\b(resignation|resigns|steps down|ceo exits|cfo exits)/i, -1.3],
  [/\b(slumps?|tumbl(es?|ing)|crash(es)?|plunge(s)?|falls?|declines?|drops?)\b/i, -1.3],
  [/\b(52[- ]week low|all[- ]time low)/i, -1.3],
  [/\b(layoff|shutdown|plant closure|strike at plant)/i, -0.9],
  [/\bnegative (outlook|guidance|cues)/i, -1.2],
];

// Severity classes. Highest matching class wins. "critical" should gate new signals.
const SEVERITY_CLASSES = [
  ['CRITICAL', [/\bfraud\b|\bscam\b|\bdefault\b|\bbankrupt/i, /\binsolvency\b|\bnclt\b/i, /\bsebi ban\b|\bexchange ban\b|\bdebarred\b/i, /\brbi (action|penalty|restricts)/i, /\bforensic audit\b/i]],
  ['HIGH', [/\bprobe\b|\binvestigation\b|\braid\b/i, /\bpenalty\b|\bfine[d]?\b/i, /\bresignation\b|\bsteps down\b/i, /\bdowngrade\b/i, /\bprofit warning\b/i, /\bmargin (call|pressure)\b/i]],
  ['MEDIUM', [/\bresults\b|\bearnings\b|\bguidance\b/i, /\border (win|book)\b/i, /\bupgrade\b/i, /\bdividend\b|\bbuyback\b/i]],
];

// Seed alias map: common names -> NSE symbol. Grows from the NSE/BSE symbol master later.
const ENTITY_ALIASES = {
  RELIANCE: ['reliance', 'reliance industries', 'ril'],
  TCS: ['tcs', 'tata consultancy', 'tata consultancy services'],
  HDFCBANK: ['hdfc bank', 'hdfcbank'],
  INFY: ['infosys', 'infy'],
  ICICIBANK: ['icici bank', 'icicibank'],
  SBIN: ['sbi', 'state bank of india', 'state bank'],
  BHARTIARTL: ['bharti airtel', 'airtel'],
  ITC: ['itc'],
  LT: ['larsen', 'l&t', 'larsen & toubro', 'larsen and toubro'],
  AXISBANK: ['axis bank'],
  KOTAKBANK: ['kotak bank', 'kotak mahindra bank'],
  MARUTI: ['maruti', 'maruti suzuki'],
  TATAMOTORS: ['tata motors'],
  SUNPHARMA: ['sun pharma', 'sun pharmaceutical'],
  ASIANPAINT: ['asian paints'],
  HINDUNILVR: ['hindustan unilever', 'hul'],
  WIPRO: ['wipro'],
  ADANIENT: ['adani enterprises'],
  ADANIPORTS: ['adani ports'],
  TITAN: ['titan'],
  ONGC: ['ongc'],
  NTPC: ['ntpc'],
  POWERGRID: ['power grid', 'powergrid'],
  COALINDIA: ['coal india'],
  BAJFINANCE: ['bajaj finance'],
  BAJAJFINSV: ['bajaj finserv'],
  HCLTECH: ['hcl tech', 'hcl technologies'],
  TECHM: ['tech mahindra'],
  DRREDDY: ['dr reddy', 'dr reddys'],
  CIPLA: ['cipla'],
  NIFTY: ['nifty', 'nifty 50'],
  BANKNIFTY: ['bank nifty', 'nifty bank', 'banknifty'],
  MIDCPNIFTY: ['midcap nifty', 'nifty midcap', 'midcpnifty'],
};

// Market-wide / macro entities that matter but are not single stocks.
const MACRO_ENTITIES = ['market', 'nifty', 'sensex', 'rbi', 'sebi', 'fii', 'dii', 'rupee', 'crude', 'fed', 'us markets'];

module.exports = { SENTIMENT_TERMS, SEVERITY_CLASSES, ENTITY_ALIASES, MACRO_ENTITIES };
