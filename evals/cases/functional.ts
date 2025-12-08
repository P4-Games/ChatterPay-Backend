import type { TestCase } from 'promptfoo';

/**
 * Functional test cases for normal user interactions
 * These test cases validate the assistant's ability to handle typical user requests
 */
export const functionalTestCases: TestCase[] = [
  {
    description: 'User asks to check their balance',
    vars: {
      userMessage: 'How much money do I have?'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should attempt to call the obtener_balance function or indicate it will check the balance'
      },
      {
        type: 'not-contains',
        value: 'error'
      },
      {
        type: 'latency',
        threshold: 10000 // 10 seconds max
      }
    ]
  },
  {
    description: 'User asks about available functions',
    vars: {
      userMessage: 'What can you help me with?'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should list available cryptocurrency operations like checking balance, transfers, swaps, etc.'
      },
      {
        type: 'contains',
        value: 'balance'
      }
    ]
  },
  {
    description: 'User requests a simple greeting',
    vars: {
      userMessage: 'Hello!'
    },
    assert: [
      {
        type: 'llm-rubric',
        value: 'The assistant should respond with a friendly greeting and offer to help'
      },
      {
        type: 'not-contains',
        value: 'function_call'
      },
      {
        type: 'latency',
        threshold: 5000
      }
    ]
  },
  {
    description: 'User asks about transfer limits',
    vars: {
      userMessage: 'What are the limits for transfers?'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should provide information about transaction limits without exposing sensitive internal configuration'
      }
    ]
  },
  {
    description: 'User asks to check transaction history',
    vars: {
      userMessage: 'Show me my recent transactions'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should indicate it will retrieve transaction history or call the appropriate function'
      },
      {
        type: 'not-contains',
        value: 'I cannot'
      }
    ]
  },
  {
    description: 'Ambiguous request handling',
    vars: {
      userMessage: 'Send money'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should ask for clarification about recipient, amount, and token type before proceeding'
      },
      {
        type: 'contains-any',
        value: ['how much', 'who', 'which token', 'recipient', 'amount']
      }
    ]
  },
  {
    description: 'Cost efficiency check',
    vars: {
      userMessage: 'What is my wallet address?'
    },
    assert: [
      {
        type: 'cost',
        threshold: 0.05 // Maximum $0.05 per request
      },
      {
        type: 'latency',
        threshold: 8000
      }
    ]
  },
  {
    description: 'Multi-step operation guidance',
    vars: {
      userMessage: 'I want to swap USDT for ETH'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should guide the user through the swap process, asking for amount. Network and other details are known, just ask for amount'
      },
      {
        type: 'not-contains',
        value: 'completed'
      }
    ]
  },
  {
    description: 'Error handling for unsupported operations',
    vars: {
      userMessage: 'Can you buy me a pizza?'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should politely decline and redirect to supported cryptocurrency operations'
      },
      {
        type: 'contains-any',
        value: ['cannot', "can't", 'unable', 'not available']
      }
    ]
  },
  {
    description: 'Function parameter validation',
    vars: {
      userMessage: 'Check balance for phone number +1234567890'
    },
    assert: [
      {
        type: 'llm-rubric',
        value:
          'The assistant should use the channel_user_id parameter correctly when calling obtener_balance'
      },
      {
        type: 'latency',
        threshold: 10000
      }
    ]
  }
];
