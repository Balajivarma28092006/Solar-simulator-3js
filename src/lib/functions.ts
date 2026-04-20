import { Store } from '@netlify/blobs';

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
  }>;
};

export function currentDateSentence() {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Today's date is ${today}.`;
}

export const SYSTEM_PROMPT = `\
You are a fact generation assistant for the Atlas of Space, an interactive Solar System explorer.

You present facts with a frank and direct tone and do not have a personality or refer to yourself in your responses. \
Keep your response direct and to-the-point: do NOT preface it with information like \
'Based on the available search results' or other preambles. ${currentDateSentence()}`;

export async function storeResponse(store: Store, key: string, stream: ReadableStream) {
  const reader = stream.getReader();
  let finalResult = '';
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event) continue;
        // Support both standard SSE `data:` lines and plain text chunks
        const dataLines = event
          .split('\n')
          .map(line => line.trimStart())
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5)); // keep everything after "data:" verbatim

        if (dataLines.length === 0) {
          // Treat whole event as raw text if there are no data lines
          finalResult += event;
          continue;
        }

        for (const payloadRaw of dataLines) {
          const payload = payloadRaw;
          if (!payload || payload.trim() === '[DONE]') continue;

          try {
            const json = JSON.parse(payload);
            if (json.content) {
              finalResult += json.content;
            } else {
              finalResult += payload;
            }
          } catch {
            finalResult += payload;
          }
        }
      }
    }
    // Persist the aggregated plain-text content
    await store.set(key, finalResult);
  } catch (error) {
    console.error('Error processing stream:', error);
  }
}

/**
 * Client-side SSE reader for streamed chat completions
 */
export async function readStreamResponse(
  response: Response,
  setActive: (active: boolean) => void,
  setData: (data: string) => void
) {
  setActive(true);
  if (!response.ok) {
    setActive(false);
    throw new Error(`Request failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html')) {
    setActive(false);
    throw new Error(
      'Received HTML instead of API stream. Check that /api routes are proxied to Netlify functions in dev.'
    );
  }

  const reader = response.body?.getReader();
  if (!reader) return '';

  let out = '';
  let buffer = '';
  const decoder = new TextDecoder();
  let sawSse = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunkText = decoder.decode(value, { stream: true });
    buffer += chunkText;

    // If we never see SSE markers, fall back to treating the entire
    // stream as plain text (handles simulateTokenGeneration output)
    if (!sawSse && !buffer.includes('\n\n') && !buffer.includes('data:')) {
      out += chunkText;
      setData(out);
      continue;
    }

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      if (!event) continue;

      // Find the first data line if present
      const dataLine = event
        .split('\n')
        .map(line => line.trimStart())
        .find(line => line.startsWith('data:'));

      if (!dataLine) {
        // No SSE prefix; treat the whole event as plain text
        out += event;
        setData(out);
        continue;
      }

      sawSse = true;
      const payloadRaw = dataLine.slice(5);
      const doneCheck = payloadRaw.trim();
      if (!payloadRaw || doneCheck === '[DONE]') continue;

      let appended = '';
      try {
        const json = JSON.parse(payloadRaw);
        if (json.content) {
          appended = json.content;
        } else {
          appended = payloadRaw;
        }
      } catch {
        // Non-JSON payload, just append raw text
        appended = payloadRaw;
      }

      out += appended;
      setData(out);
    }
  }

  setActive(false);
  return out;
}

export function slugifyId(id: string): string {
  return id.replace(/\//g, '-');
}

export function errorResponse(message: string) {
  return new Response(JSON.stringify({ message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function asSse(content: string) {
  return `data: ${JSON.stringify({ content })}\n\n`;
}

/**
 * Converts provider stream chunks into JSON SSE events.
 */
export function asSseStream(stream: AsyncIterable<ChatCompletionChunk>): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const chunk of stream) {
          const text = chunk.choices?.[0]?.delta?.content;
          if (!text) continue;

          controller.enqueue(encoder.encode(asSse(text)));
        }

        // send done signal (optional but good practice)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        console.error('Stream error:', error);
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * 🔥 FIXED: Safe SSE parser (no JSON crash)
 */
export function fromSseStream(stream: string) {
  let result = '';
  const lines = stream.split('\n');

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;

    const data = trimmed.slice(5);
    const doneCheck = data.trim();
    if (!data || doneCheck === '[DONE]') continue;

    try {
      const json = JSON.parse(data);
      if (json.content) {
        result += json.content;
      } else {
        result += data;
      }
    } catch {
      // Prevent "Unexpected token M" crash
      continue;
    }
  }

  return result;
}

export function simulateTokenGeneration(eventStream: string, delayMin = 10, delayMax = 25) {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const chunks = eventStream.split(' ');
    for (const chunk of chunks) {
      await new Promise(r => setTimeout(r, Math.random() * (delayMax - delayMin) + delayMin));
      // Emit SSE JSON events so the client parser can handle cached streams
      const sse = asSse(chunk + ' ');
      await writer.write(encoder.encode(sse));
    }
    // Send a DONE marker for completeness
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  })();

  return stream.readable;
}
