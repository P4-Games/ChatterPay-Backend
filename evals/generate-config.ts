#!/usr/bin/env node
/**
 * Script to run promptfoo evaluation with MongoDB-loaded configuration
 * This pre-loads data from MongoDB and generates a temporary config file
 */

import { writeFileSync } from 'fs';
import { loadPromptConfig, closeMongoDB } from './loadFromMongo.ts';
import { functionalTestCases } from './cases/functional.ts';
import { securityTestCases } from './cases/security.ts';

async function generateConfig() {
  console.log('Loading configuration from MongoDB...');
  const config = await loadPromptConfig();

  // Transform test cases to the correct format
  const allTests = [...functionalTestCases, ...securityTestCases].map((test) => ({
    ...test,
    vars: {
      ...test.vars,
      query: test.vars?.userMessage || ''
    }
  }));

  const promptfooConfig = {
    description: 'ChatterPay AI Assistant Evaluation - Claude vs GPT-4o',

    providers: ['anthropic:messages:claude-sonnet-4-20250514', 'openai:chat:gpt-4o'],

    prompts: [
      {
        id: 'chatterpay-assistant',
        label: 'ChatterPay Assistant with Tools',
        raw: config.systemPrompt + '\n\nUser: {{query}}'
      }
    ],

    tests: allTests,

    outputPath: './evals/output/results.json',
    tools: config.tools
  };

  // Write temporary config
  writeFileSync('./evals/.promptfoo-temp-config.json', JSON.stringify(promptfooConfig, null, 2));

  console.log('✅ Configuration generated at evals/.promptfoo-temp-config.json');
  console.log(`📝 System prompt: ${config.systemPrompt.substring(0, 100)}...`);
  console.log(`🔧 ${config.tools.length} tools loaded`);
  console.log(`🧪 ${allTests.length} test cases ready`);
  console.log('\nRun evaluation with:');
  console.log('  npx promptfoo eval -c evals/.promptfoo-temp-config.json');

  await closeMongoDB();
}

generateConfig().catch((error) => {
  console.error('❌ Failed to generate config:', error);
  process.exit(1);
});
