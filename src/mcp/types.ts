export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface McpToolInputSchema {
  type: "object";
  properties?: Record<string, McpToolProperty>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: McpToolContent[];
  isError?: boolean;
}

export interface McpToolHandler {
  definition: McpToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<McpToolCallResult>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: {
    type: "text";
    text: string;
  };
}
