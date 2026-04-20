import { getStore } from '@netlify/blobs';
import { Groq } from 'groq-sdk';
import { asSse, asSseStream, errorResponse, simulateTokenGeneration, storeResponse, SYSTEM_PROMPT } from '../src/lib/functions';

export default async function handle(request: Request) {
  const params = new URL(request.url).searchParams;
  const search = params.get('search');
  if (search == null || search === '') {
    return errorResponse("Bad Request: missing 'search' parameter");
  }

  const stream = params.get('stream') !== 'false';

  const responseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  const store = getStore('summary');
  const stored = await store.get(search);

  // ✅ Serve from cache if available (unchanged behavior)
  if (stored != null) {
    const content = stream ? simulateTokenGeneration(stored) : asSse(stored);
    return new Response(content, { headers: responseHeaders });
  }

  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });

  const prompt = `
Generate a concise 3-4 sentence summary of ${search}.

Requirements:
- Return exactly 3 or 4 sentences.
- Keep it factual, specific, and information-dense.
- Avoid generic filler or intro/conclusion text.
- If a detail is uncertain, skip it rather than guessing.

Return ONLY the summary text.
`;

  // Streaming completion using Groq chat API
  const completionStream = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    stream: true,
    max_completion_tokens: 240,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  // Convert streamed chunks into JSON SSE for the frontend parser/cache
  const readableStream = asSseStream(completionStream);

  const [streamForResponse, streamForStore] = readableStream.tee();

  // ✅ Cache stream exactly like before
  storeResponse(store, search, streamForStore);

  return new Response(streamForResponse, { headers: responseHeaders });
}
