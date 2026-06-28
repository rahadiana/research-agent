/**
 * Research Agent — Multi-Platform AI Research Agent
 * Entry point
 */

import dotenv from 'dotenv';
dotenv.config();

export { ResearchEngine } from './core/research-engine.js';
export type { ResearchQuery, ResearchResult, ResearchReport, Source } from './types/index.js';
