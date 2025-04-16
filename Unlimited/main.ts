import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 定义常量
const UNLIMITED_AI_URL = "https://app.unlimitedai.chat/api/chat";
const PORT = 3000;
const MAX_RETRIES = 3;

// 定义接口
interface UnlimitedAIMessage {
  id: string;
  createdAt: string;
  role: string;
  content: string;
  parts: Array<{ type: string; text: string }>;
}

interface OpenAIMessage {
  role: string;
  content: string;
}

// 将OpenAI消息转换为UnlimitedAI消息
function convertOpenAIToUnlimitedMessages(messages: OpenAIMessage[]): UnlimitedAIMessage[] {
  // 提取系统消息
  const systemMessages = messages.filter(msg => msg.role === "system");
  const nonSystemMessages = messages.filter(msg => msg.role !== "system");
  
  const result: UnlimitedAIMessage[] = [];
  
  // 如果有系统消息，将其转换为用户消息和助手回复
  if (systemMessages.length > 0) {
    // 合并所有系统消息内容
    const systemContent = systemMessages.map(msg => msg.content).join("\n\n");
    
    // 添加作为用户消息的系统提示
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "user",
      content: systemContent,
      parts: [{ type: "text", text: systemContent }],
    });
    
    // 添加助手确认回复
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "assistant",
      content: "Ok, I got it, I'll remember it and do it.",
      parts: [{ type: "text", text: "Ok, I got it, I'll remember it and do it." }],
    });
  }
  
  // 添加其余非系统消息
  nonSystemMessages.forEach(msg => {
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: msg.role,
      content: msg.content,
      parts: [{ type: "text", text: msg.content }],
    });
  });
  
  return result;
}

// 将OpenAI请求体转换为UnlimitedAI请求体
function convertOpenAIToUnlimitedBody(openaiBody: any): any {
  return {
    id: openaiBody.id || crypto.randomUUID(),
    messages: convertOpenAIToUnlimitedMessages(openaiBody.messages),
    selectedChatModel: openaiBody.model || "chat-model-reasoning",
  };
}

// 处理流式响应
async function* transformStreamResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string> {
  let buffer = "";
  const decoder = new TextDecoder();
  let messageId = "";
  let firstResult = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        yield "data: [DONE]\n\n";
        break;
      }
      
      buffer += decoder.decode(value, { stream: true });
      let lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        
        const key = line.slice(0, idx);
        let val = line.slice(idx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        
        if (key === "f") {
          // 记录 messageId
          try {
            const obj = JSON.parse(val);
            messageId = obj.messageId || "";
          } catch (error) {
            console.error("Error parsing messageId:", error);
          }
        } else if (key === "g") {
          const delta = firstResult
            ? {
                role: "assistant",
                reasoning_content: val.replace(/\\n/g, "\n"),
              }
            : { reasoning_content: val.replace(/\\n/g, "\n") };
          
          // 思考过程
          const chunk = {
            id: messageId || crypto.randomUUID(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "chat-model-reasoning",
            choices: [
              {
                delta,
                index: 0,
                finish_reason: null,
              },
            ],
          };
          
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        } else if (key === "0") {
          // 最终结果
          const delta = { content: val.replace(/\\n/g, "\n") };
          const chunk = {
            id: messageId || crypto.randomUUID(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "chat-model-reasoning",
            choices: [
              {
                delta,
                index: 0,
                finish_reason: null,
              },
            ],
          };
          
          yield `data: ${JSON.stringify(chunk)}\n\n`;
          firstResult = false;
        } else if (key === "e" || key === "d") {
          // 结束
          yield "data: [DONE]\n\n";
        }
      }
    }
  } catch (error) {
    console.error("Stream transformation error:", error);
    yield "data: [DONE]\n\n";
  } finally {
    reader.releaseLock();
  }
}

// 转换非流式响应
async function transformNonStreamResponse(text: string): Promise<any> {
  const lines = text.split("\n");
  const data: Record<string, any> = {};
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    
    const key = line.slice(0, idx);
    let val = line.slice(idx + 1).trim();
    try {
      val = JSON.parse(val);
    } catch (error) {
      // 如果解析失败，保持原始字符串
    }
    
    data[key] = val;
  }
  
  const content = data["0"];
  const reasoning_content = data.g;
  
  return {
    id: data.f?.messageId || crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "chat-model-reasoning",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          reasoning_content,
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

// 处理聊天完成请求
async function handleChatCompletions(
  openaiBody: any,
  isStream: boolean,
  retryCount = 0
): Promise<Response> {
  try {
    // 转换为 UnlimitedAI.Chat 请求体
    const unlimitedBody = convertOpenAIToUnlimitedBody(openaiBody);
    
    // 只转发必要 headers
    const upstreamHeaders = {
      "content-type": "application/json",
      // 可以根据需要转发 Authorization 等
    };
    
    // 转发到 UnlimitedAI.Chat
    const upstreamRes = await fetch(UNLIMITED_AI_URL, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(unlimitedBody),
    });
    
    if (!upstreamRes.ok) {
      throw new Error(`Chat completion failed: ${upstreamRes.status}`);
    }
    
    if (isStream) {
      // 流式响应处理
      const reader = upstreamRes.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response body reader");
      }
      
      const transformedStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of transformStreamResponse(reader)) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          } catch (error) {
            console.error("Stream transformation error:", error);
            controller.error(error);
          }
        },
      });
      
      return new Response(transformedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      // 非流式响应处理
      const text = await upstreamRes.text();
      const transformedResponse = await transformNonStreamResponse(text);
      
      return new Response(JSON.stringify(transformedResponse), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  } catch (error) {
    console.error("Request handling error:", error);
    
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// 主处理函数
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS预检请求处理
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    // 模型列表接口
    if (path === "/v1/models" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "chat-model-reasoning",
              object: "model",
              created: 0,
              owned_by: "unlimitedai",
              permission: [{
                id: "modelperm-chat-model-reasoning",
                object: "model_permission",
                created: 0,
                allow_create_engine: false,
                allow_sampling: true,
                allow_logprobs: false,
                allow_search_indices: false,
                allow_view: true,
                allow_fine_tuning: false,
                organization: "*",
                group: null,
                is_blocking: false,
              }],
              root: "chat-model-reasoning",
              parent: null,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    
    // 聊天完成接口
    else if (path === "/v1/chat/completions" && req.method === "POST") {
      const openaiBody = await req.json();
      const isStream = openaiBody.stream === true;
      
      return await handleChatCompletions(openaiBody, isStream);
    }
    
    // 未找到路由
    else {
      return new Response(
        JSON.stringify({ error: "Not found", message: "Endpoint not supported" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  } catch (error) {
    console.error("Request handling error:", error);
    
    return new Response(
      JSON.stringify({ error: "Internal server error", message: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// 启动服务器
console.log(`Starting server on port ${PORT}...`);
serve(handler, { port: PORT });
