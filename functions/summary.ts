import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
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

  // ✅ OpenRouter client (OpenAI-compatible)
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const prompt = `
Generate a 1-sentence summary of ${search}.

Examples of good summaries:

Phobos:
A small, irregularly shaped moon that orbits once every 7 hours only ~6000 km from the planet's surface.

Iapetus:
A distinctive moon with a highly inclined orbit, dramatic two-toned coloration, and a prominent equatorial ridge that gives it a walnut-like appearance.

Return ONLY one concise sentence.
`;

  // 🔥 Streaming completion (free model)
  const completionStream = await client.chat.completions.create({
    model: 'openai/gpt-5.2',
    // model: 'gpt-4o-mini',
    stream: true,
    max_tokens: 120,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  // ✅ Convert OpenAI stream → JSON SSE using shared helper
  const readableStream = asSseStream(completionStream);

  const [streamForResponse, streamForStore] = readableStream.tee();

  // ✅ Cache stream exactly like before
  storeResponse(store, search, streamForStore);

  return new Response(streamForResponse, { headers: responseHeaders });
}
