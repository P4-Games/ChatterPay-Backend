import mongoose from 'mongoose';

/**
 * MongoDB collection interfaces based on the chatterpay database schema
 */
interface ChatFunction {
  _id: { $oid: string };
  name: string;
  active: string;
  api_config: {
    url: string;
    auth: {
      strategy: string;
      type: string;
    };
    headers: Record<string, string>;
    parameters: Record<string, unknown>;
    required_parameters: string[];
    method: string;
    user_parameters: Record<string, string>;
  };
  model_config: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };
    };
  };
}

interface ChatMode {
  _id: { $oid: string };
  date: { $date: string };
  default: {
    start_system_message: string;
    end_system_message: string;
  };
}

/**
 * Promptfoo configuration types
 */
export interface PromptConfig {
  systemPrompt: string;
  tools: Tool[];
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Connect to MongoDB using the existing connection configuration
 */
async function connectToMongoDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    console.log('[loadFromMongo] Already connected to MongoDB');
    return;
  }

  const mongoUri = process.env.CHATIZALO_MONGO_URI ?? 'mongodb://localhost:27017/chatterpay-develop';
  console.log(`[loadFromMongo] Connecting to MongoDB: ${mongoUri}`);

  try {
    await mongoose.connect(mongoUri);
    console.log('[loadFromMongo] MongoDB connected successfully');
  } catch (error) {
    console.error('[loadFromMongo] Failed to connect to MongoDB:', error);
    throw error;
  }
}

/**
 * Load system prompt from chat_modes collection
 */
async function loadSystemPrompt(): Promise<string> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established');
  }

  const collection = db.collection<ChatMode>('chat_modes');
  const chatMode = await collection.findOne({});

  if (!chatMode || !chatMode.default?.start_system_message) {
    throw new Error('No chat mode found or start_system_message is missing');
  }

  console.log('[loadFromMongo] System prompt loaded successfully');
  return chatMode.default.start_system_message;
}

/**
 * Load active chat functions from chat_functions collection
 */
async function loadChatFunctions(): Promise<Tool[]> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established');
  }

  const collection = db.collection<ChatFunction>('chat_functions');
  const functions = await collection.find({ active: 'true' }).toArray();

  console.log(`[loadFromMongo] Loaded ${functions.length} active chat functions`);

  // Transform MongoDB chat functions to OpenAI/Anthropic tool format
  const tools: Tool[] = functions.map((func) => ({
    type: 'function' as const,
    function: {
      name: func.model_config.function.name,
      description: func.model_config.function.description,
      parameters: func.model_config.function.parameters,
    },
  }));

  return tools;
}

/**
 * Main function to load prompt configuration from MongoDB
 */
export async function loadPromptConfig(): Promise<PromptConfig> {
  await connectToMongoDB();

  const [systemPrompt, tools] = await Promise.all([loadSystemPrompt(), loadChatFunctions()]);

  console.log('[loadFromMongo] Prompt configuration loaded successfully');
  console.log(`[loadFromMongo] System prompt length: ${systemPrompt.length} characters`);
  console.log(`[loadFromMongo] Tools count: ${tools.length}`);

  return {
    systemPrompt,
    tools,
  };
}

/**
 * Utility function to close MongoDB connection
 */
export async function closeMongoDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
    console.log('[loadFromMongo] MongoDB connection closed');
  }
}

// Allow running this file standalone to test the connection
if (import.meta.main) {
  (async () => {
    try {
      const config = await loadPromptConfig();
      console.log('✅ Successfully loaded prompt configuration');
      console.log(`📝 System prompt: ${config.systemPrompt.substring(0, 100)}...`);
      console.log(`🔧 Tools: ${config.tools.map((t) => t.function.name).join(', ')}`);
      await closeMongoDB();
    } catch (error) {
      console.error('❌ Failed to load prompt configuration:', error);
      process.exit(1);
    }
  })();
}
