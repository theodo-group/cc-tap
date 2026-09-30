export interface CaptureRow {
  request_id: string
  session_id: string | null
  account_uuid: string | null
  device_id: string | null
  cc_version: string | null
  cc_entrypoint: string | null
  cc_config_hash: string | null
  timestamp: number
  duration_ms: number | null
  method: string
  path: string
  model: string | null
  is_streaming: number
  status_code: number | null
  error: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  system_blocks: number | null
  message_count: number | null
  tool_count: number | null
  request_body_path: string
  response_body_path: string | null
  request_body_bytes: number
  response_body_bytes: number | null
  // NULL on rows written before the column existed (always the proxy then).
  source?: string | null
}

// How a capture was recorded: through the local proxy, or ingested from the
// bodies Claude Code logs itself (OTEL_LOG_RAW_API_BODIES), whose streamed
// responses are re-serialized from the final message rather than wire SSE.
export type CaptureSource = 'proxy' | 'otel'

export interface CaptureSummary {
  request_id: string
  session_id: string | null
  timestamp: number
  duration_ms: number | null
  method: string
  path: string
  model: string | null
  is_streaming: boolean
  status_code: number | null
  error: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  system_blocks: number | null
  message_count: number | null
  tool_count: number | null
  request_body_bytes: number
  response_body_bytes: number | null
  cc_version: string | null
  source: CaptureSource
}

// A single content block as it appears in a request message or system entry.
export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: string; ttl?: string } | null }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: { type: string; ttl?: string } | null }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean; cache_control?: { type: string; ttl?: string } | null }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: string; [k: string]: unknown }

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: unknown
  cache_control?: { type: string; ttl?: string } | null
}

export interface AnthropicRequestBody {
  model?: string
  max_tokens?: number
  stream?: boolean
  thinking?: unknown
  output_config?: unknown
  context_management?: unknown
  metadata?: { user_id?: string }
  system?: AnthropicContentBlock[] | string
  messages?: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>
  tools?: AnthropicTool[]
}

export interface CaptureDetail {
  summary: CaptureSummary
  request_body: AnthropicRequestBody | null
  // raw response body — for streaming responses, this is the concatenated SSE text.
  // for non-streaming responses, this is the parsed JSON.
  response_body: unknown
  response_text: string | null
}
