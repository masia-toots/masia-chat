import { createTsMlsEngine } from '../ts-mls-engine.js';
import { defineEngineContract } from './engine-contract.js';
import { createTsMlsAdversary } from './support/ts-mls-adversary.js';

defineEngineContract({
  name: 'ts-mls engine',
  factory: createTsMlsEngine,
  adversary: createTsMlsAdversary,
});
