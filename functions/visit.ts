import { getStore } from '@netlify/blobs';
import { Groq } from 'groq-sdk';
import { asSse, asSseStream, errorResponse, simulateTokenGeneration, storeResponse, SYSTEM_PROMPT } from '../src/lib/functions';

const CACHE_KEY_VERSION = 'v2';

export default async function handle(request: Request) {
  const params = new URL(request.url).searchParams;
  const search = params.get('search');

  if (!search) {
    return errorResponse("Bad Request: missing 'search' parameter");
  }

  const blobId = params.get('blobId') ?? search;
  const streamEnabled = params.get('stream') !== 'false';

  const responseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  const store = getStore('visit');
  const cacheKey = `${CACHE_KEY_VERSION}:${blobId}`;
  const stored = await store.get(cacheKey);

  // ✅ Serve cached version if exists
  if (stored != null) {
    const content = streamEnabled ? simulateTokenGeneration(stored) : asSse(stored);

    return new Response(content, { headers: responseHeaders });
  }

  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });

  const prompt = `
Generate a concise 5-6 sentence summary of ${search}.
Do not restate the organization that launched the spacecraft.

Requirements:
- Return exactly 5 or 6 sentences.
- Focus on mission events, timeline, objectives, and outcomes.
- Keep it factual and avoid hype or filler.
- If details are uncertain, omit them instead of speculating.

Examples of detail level:

An interplanetary probe launched in 1972 that became the first spacecraft to cross the asteroid belt, visit Jupiter, and leave the Solar System.

Apollo 11 became the first manned spacecraft to land on the Moon in 1969.

Hayabusa2 rendezvoused with Ryugu in 2018, deployed landers, collected samples, and returned them to Earth.

Return ONLY the summary text.
`;

  const completionStream = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    stream: true,
    max_completion_tokens: 420,
    temperature: 0.4,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  // Convert streamed chunks into JSON SSE for the frontend parser/cache
  const readableStream = asSseStream(completionStream);

  const [streamForResponse, streamForStore] = readableStream.tee();

  // ✅ Store stream for caching
  storeResponse(store, cacheKey, streamForStore);

  return new Response(streamForResponse, {
    headers: responseHeaders,
  });
}
