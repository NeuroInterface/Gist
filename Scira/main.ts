import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 定义常量
const API_URL = "https://mcp.scira.ai/api/chat";
const FIXED_USER_ID = "2jFMDM1A1R_XxOTxPjhwe";
const FIXED_CHAT_ID = "ZIWa36kd6MSqzw-ifXGzE";
const DEFAULT_MODEL = "qwen-qwq";
const PORT = 8888;

// 定义接口
interface Message {
  role: string;
  content: string;
  parts?: Array<{
    type: string;
    text: string;
  }>;
}

interface SciraPayload {
  id: string;
  messages: Message[];
  selectedModel: string;
  mcpServers: any[];
  chatId: string;
  userId: string;
}

interface OpenAIModel {
  id: string;
  created: number;
  object: string;
}

// 可用模型列表
const AVAILABLE_MODELS: OpenAIModel[] = [
  {
    id: "qwen-qwq",
    created: Date.now(),
    object: "model",
  },
  {
    id: "gemini-2.5-flash",
    created: Date.now(),
    object: "model",
  },
  {
    id: "gpt-4.1-mini",
    created: Date.now(),
    object: "model",
  },
  {
    id: "claude-3-7-sonnet",
    created: Date.now(),
    object: "model",
  },
];

// 格式化消息为Scira格式
function formatMessagesForScira(messages: Message[]): Message[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
    parts: [{
      type: "text",
      text: msg.content
    }]
  }));
}

// 构建Scira请求负载
function buildSciraPayload(messages: Message[], model = DEFAULT_MODEL): SciraPayload {
  const formattedMessages = formatMessagesForScira(messages);
  return {
    id: FIXED_CHAT_ID,
    messages: formattedMessages,
    selectedModel: model,
    mcpServers: [],
    chatId: FIXED_CHAT_ID,
    userId: FIXED_USER_ID
  };
}

// 处理模型列表请求
async function handleModelsRequest(): Promise<Response> {
  const response = {
    object: "list",
    data: AVAILABLE_MODELS,
  };
  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
  });
}

// 处理聊天补全请求
async function handleChatCompletionsRequest(req: Request): Promise<Response> {
  const requestData = await req.json();
  const { messages, model = DEFAULT_MODEL, stream = false } = requestData;
  
  const sciraPayload = buildSciraPayload(messages, model);
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
      "Accept": "*/*",
      "Referer": `https://mcp.scira.ai/chat/${FIXED_CHAT_ID}`,
      "Origin": "https://mcp.scira.ai",
    },
    body: JSON.stringify(sciraPayload),
  });

  if (stream) {
    return handleStreamResponse(response, model);
  } else {
    return handleRegularResponse(response, model);
  }
}

// 处理流式响应
async function handleStreamResponse(response: Response, model: string): Promise<Response> {
  const reader = response.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
  const createdTime = Math.floor(Date.now() / 1000);
  const systemFingerprint = `fp_${Math.random().toString(36).substring(2, 12)}`;
  
  const stream = new ReadableStream({
    async start(controller) {
      // 发送流式头部
      const headerEvent = {
        id: id,
        object: "chat.completion.chunk",
        created: createdTime,
        model: model,
        system_fingerprint: systemFingerprint,
        choices: [{
          index: 0,
          delta: { role: "assistant" },
          logprobs: null,
          finish_reason: null
        }]
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(headerEvent)}\n\n`));
      
      try {
        let buffer = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          // 解码当前数据块并添加到缓冲区
          buffer += decoder.decode(value, { stream: true });
          
          // 处理完整的行
          const lines = buffer.split('\n');
          // 保留最后一个可能不完整的行
          buffer = lines.pop() || "";
          
          // 处理并立即发送每一行
          for (const line of lines) {
            if (!line.trim()) continue;

            if (line.startsWith('g:')) {
              // 对于g开头的行，输出reasoning_content
              let content = line.slice(2).replace(/^"/, "").replace(/"$/, "");
              content = content.replace(/\\n/g, "\n");
              
              const event = {
                id: id,
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                system_fingerprint: systemFingerprint,
                choices: [{
                  index: 0,
                  delta: { reasoning_content: content },
                  logprobs: null,
                  finish_reason: null
                }]
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } else if (line.startsWith('0:')) {
              // 对于0开头的行，输出content
              let content = line.slice(2).replace(/^"/, "").replace(/"$/, "");
              content = content.replace(/\\n/g, "\n");
              
              const event = {
                id: id,
                object: "chat.completion.chunk",
                created: createdTime,
                model: model,
                system_fingerprint: systemFingerprint,
                choices: [{
                  index: 0,
                  delta: { content: content },
                  logprobs: null,
                  finish_reason: null
                }]
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } else if (line.startsWith('e:')) {
              // 完成消息
              try {
                const finishData = JSON.parse(line.slice(2));
                const event = {
                  id: id,
                  object: "chat.completion.chunk",
                  created: createdTime,
                  model: model,
                  system_fingerprint: systemFingerprint,
                  choices: [{
                    index: 0,
                    delta: {},
                    logprobs: null,
                    finish_reason: finishData.finishReason || "stop"
                  }]
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch (error) {
                console.error("Error parsing finish data:", error);
              }
            }
          }
        }
        
        // 处理缓冲区中剩余的内容（如果有的话）
        if (buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith('g:')) {
            let content = line.slice(2).replace(/^"/, "").replace(/"$/, "");
            content = content.replace(/\\n/g, "\n");
            
            const event = {
              id: id,
              object: "chat.completion.chunk",
              created: createdTime,
              model: model,
              system_fingerprint: systemFingerprint,
              choices: [{
                index: 0,
                delta: { reasoning_content: content },
                logprobs: null,
                finish_reason: null
              }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } else if (line.startsWith('0:')) {
            let content = line.slice(2).replace(/^"/, "").replace(/"$/, "");
            content = content.replace(/\\n/g, "\n");
            
            const event = {
              id: id,
              object: "chat.completion.chunk",
              created: createdTime,
              model: model,
              system_fingerprint: systemFingerprint,
              choices: [{
                index: 0,
                delta: { content: content },
                logprobs: null,
                finish_reason: null
              }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        }
      } catch (error) {
        console.error("Stream error:", error);
      } finally {
        // 确保发送 "data: [DONE]"
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// 处理非流式响应
async function handleRegularResponse(response: Response, model: string): Promise<Response> {
  const text = await response.text();
  const lines = text.split('\n');
  
  let content = "";
  let reasoning_content = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finish_reason = "stop";
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    if (line.startsWith('0:')) {
      // 常规内容 - 处理转义的换行符
      let lineContent = line.slice(2).replace(/^"/, "").replace(/"$/, "");
      lineContent = lineContent.replace(/\\n/g, "\n");
      content += lineContent;
    } else if (line.startsWith('g:')) {
      // 推理内容 - 处理转义的换行符
      let lineContent = line.slice(2).replace(/^"/, "").replace(/"$/, "");
      lineContent = lineContent.replace(/\\n/g, "\n");
      reasoning_content += lineContent;
    } else if (line.startsWith('e:')) {
      try {
        const finishData = JSON.parse(line.slice(2));
        if (finishData.finishReason) {
          finish_reason = finishData.finishReason;
        }
      } catch (error) {
        console.error("Error parsing finish data:", error);
      }
    } else if (line.startsWith('d:')) {
      try {
        const finishData = JSON.parse(line.slice(2));
        if (finishData.usage) {
          usage.prompt_tokens = finishData.usage.promptTokens || 0;
          usage.completion_tokens = finishData.usage.completionTokens || 0;
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
      } catch (error) {
        console.error("Error parsing usage data:", error);
      }
    }
  }
  
  const systemFingerprint = `fp_${Math.random().toString(36).substring(2, 12)}`;
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;

  const openAIResponse = {
    id: id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    system_fingerprint: systemFingerprint,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      logprobs: null,
      finish_reason: finish_reason
    }],
    usage: usage
  };
  
  // 如果存在推理内容，添加到消息中
  if (reasoning_content.trim()) {
    openAIResponse.choices[0].message.reasoning_content = reasoning_content;
  }
  
  return new Response(JSON.stringify(openAIResponse), {
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
  });
}

// 主请求处理函数
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // 设置CORS头
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  
  // 处理OPTIONS请求（CORS预检）
  if (req.method === "OPTIONS") {
    return new Response(null, { 
      headers,
      status: 204 
    });
  }
  
  try {
    // 处理模型列表接口
    if (url.pathname === "/v1/models") {
      return handleModelsRequest();
    }
    
    // 处理聊天补全接口
    if (url.pathname === "/v1/chat/completions") {
      return handleChatCompletionsRequest(req);
    }
    
    // 未找到的路由
    return new Response(
      JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { 
          "Content-Type": "application/json",
          ...headers 
        },
      }
    );
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          ...headers 
        },
      }
    );
  }
}

// 启动服务器
console.log(`Starting server on port ${PORT}...`);
serve(handler, { port: PORT });
