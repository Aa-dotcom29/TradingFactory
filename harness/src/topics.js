'use strict';

// Canonical queue topics shared by every worker. Keeping them in one place is what lets
// workers be added, replaced or replayed independently of each other.

const TOPICS = {
  NEWS_RAW: 'news.raw', // W0 -> W1: normalized-but-unscored news item
  NEWS_SCORED: 'news.scored', // W1 -> W3: entity/sentiment/severity enriched news
  FLOW_SNAPSHOT: 'flow.snapshot', // W0/W2 -> W3: OI spurt + volume-flow features
  FEATURE_SNAPSHOT: 'feature.snapshot', // W2 -> W3: engineered features per symbol
  BIAS: 'bias.verdict', // W3 -> W4: direction + probability + evidence
  SIGNAL_CANDIDATE: 'signal.candidate', // W4 -> W5: proposed signal awaiting risk
  SIGNAL_APPROVED: 'signal.approved', // W5 -> W6: risk-passed signal
  SIGNAL_REJECTED: 'signal.rejected', // W5 -> (audit)
  PUBLISHED: 'signal.published', // W6 -> W7: delivered signal
  EVALUATE: 'evaluate.signal', // W7: outcome scoring request
};

const HORIZONS = ['INTRADAY', 'SWING', 'POSITIONAL'];

module.exports = { TOPICS, HORIZONS };
