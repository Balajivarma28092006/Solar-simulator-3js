import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
import { asSse, asSseStream, errorResponse, simulateTokenGeneration, storeResponse, SYSTEM_PROMPT } from '../src/lib/functions';

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
  const stored = await store.get(blobId);

  // ✅ Serve cached version if exists
  if (stored != null) {
    const content = streamEnabled ? simulateTokenGeneration(stored) : asSse(stored);

    return new Response(content, { headers: responseHeaders });
  }

  // ✅ OpenRouter client (FREE models)
  // console.log(process.env.OPENROUTER_API_KEY);
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const prompt = `
Generate a brief 1-sentence summary of ${search}.
Do not restate the organization that launched the spacecraft.

Examples:

An interplanetary probe launched in 1972 that became the first spacecraft to cross the asteroid belt, visit Jupiter, and leave the Solar System.

Apollo 11 became the first manned spacecraft to land on the Moon in 1969.

Hayabusa2 rendezvoused with Ryugu in 2018, deployed landers, collected samples, and returned them to Earth.
`;

  const completionStream = await client.chat.completions.create({
    model: 'openai/gpt-5.2', // FREE model
    // model: 'gpt-4o-mini',
    stream: true,
    max_tokens: 200,
    temperature: 0.4,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  // ✅ Convert OpenAI stream → JSON SSE using shared helper
  const readableStream = asSseStream(completionStream);

  const [streamForResponse, streamForStore] = readableStream.tee();

  // ✅ Store stream for caching
  storeResponse(store, blobId, streamForStore);

  return new Response(streamForResponse, {
    headers: responseHeaders,
  });
}
