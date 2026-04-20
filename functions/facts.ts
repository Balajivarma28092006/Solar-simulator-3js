import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
import { asSseStream, errorResponse, simulateTokenGeneration, storeResponse, SYSTEM_PROMPT } from '../src/lib/functions';

/**
 * Step 1: Fetch Wikidata ID
 */
async function getWikidataId(search: string): Promise<string | undefined> {
  const baseUrl = 'https://www.wikidata.org/w/api.php';
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: search,
    format: 'json',
  });

  const response = await fetch(`${baseUrl}?${params}`);
  if (!response.ok) {
    throw new Error('Failed to fetch ID from Wikidata');
  }

  const body = await response.json();
  return body.query.search?.[0]?.title;
}

type WikidataDatum = {
  label: string;
  value: string;
  units: string | null;
};

/**
 * Step 2: Fetch Wikidata SPARQL info
 */
async function getWikidataInfo(id: string): Promise<Array<WikidataDatum>> {
  const endpointUrl = 'https://query.wikidata.org/sparql';

  const sparqlQuery = `
SELECT ?property ?propertyLabel ?value ?valueLabel ?unit ?unitLabel
WHERE {
  wd:${id} ?p ?statement .
  ?property wikibase:claim ?p ;
            wikibase:statementProperty ?ps .

  ?statement ?ps ?value .

  OPTIONAL {
    ?statement ?ps ?quantity.
    FILTER(DATATYPE(?quantity) = xsd:decimal || DATATYPE(?quantity) = wikibase:quantityAmount)
    ?statement ?psv ?valueNode .
    ?valueNode wikibase:quantityAmount ?value ;
              wikibase:quantityUnit ?unit .
  }

  SERVICE wikibase:label { 
    bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en". 
  }
}
`;

  const params = new URLSearchParams({
    query: sparqlQuery,
    format: 'json',
  });

  const response = await fetch(`${endpointUrl}?${params}`, {
    headers: {
      'User-Agent': 'Atlas of Space/1.0 (free-llm@openrouter.ai)',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch info from Wikidata');
  }

  const body = await response.json();
  const bindings: Array<any> = body.results.bindings;

  return bindings.map(b => ({
    label: b.propertyLabel?.value ?? 'Unknown',
    value: b.valueLabel?.value ?? 'Unknown',
    units: b.unitLabel?.value ?? null,
  }));
}

/**
 * Step 3: Convert Wikidata to CSV (for LLM grounding)
 */
function wikidataInfoAsCsv(wikidataInfo: Array<WikidataDatum>): string {
  const rows = wikidataInfo.map(({ label, value, units }) => `"${label}","${value}","${units ?? ''}"`).join('\n');

  return `label,value,units\n${rows}`;
}

/**
 * 🔥 Step 4: FREE LLM (OpenRouter Streaming)
 * Uses free models via OpenRouter and converts to JSON SSE.
 */
async function formatWithFreeLLM(search: string, wikidataInfo: Array<WikidataDatum>) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const prompt = `
What facts can you tell me about '${search}'?

Include ONLY:
- Discovery date
- Discoverer and circumstances
- Name origins
- Dimensions (for non-spherical bodies only)
- Rotation facts (e.g. tidally locked or not)
- Albedo (if known)
- Material composition (if known)
- Density (if known)

Exclude:
- Orbital characteristics
- Space missions
- Satellites
- Anything unknown

Format STRICTLY as markdown bullet points with **bolded** keys.
Do NOT write any intro or conclusion.

Wikidata CSV:
${wikidataInfoAsCsv(wikidataInfo)}
`;

  const openaiStream = await client.chat.completions.create({
    model: 'openai/gpt-5.2', // FREE model
    // model: 'gpt-4o-mini',
    stream: true,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  // Wrap OpenAI stream in JSON SSE events
  return asSseStream(openaiStream);
}

/**
 * 🚀 Netlify Function Handler (UNCHANGED LOGIC)
 */
export default async function handle(request: Request) {
  const params = new URL(request.url).searchParams;
  const search = params.get('search');

  if (search == null || search === '') {
    return errorResponse("Bad Request: missing 'search' parameter");
  }

  const blobId = params.get('blobId') ?? search;

  const responseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  const store = getStore('facts');
  const stored = await store.get(blobId);

  // Serve cached response if exists
  if (stored != null) {
    return new Response(simulateTokenGeneration(stored, 5, 15), {
      headers: responseHeaders,
    });
  }

  // Fetch Wikidata
  const id = await getWikidataId(search);
  if (!id) {
    return errorResponse('No Wikidata entity found for search');
  }

  const info = await getWikidataInfo(id);

  // Use FREE LLM instead of Anthropic
  const stream = await formatWithFreeLLM(search, info);
  const [streamForResponse, streamForStore] = stream.tee();

  // Cache in background
  storeResponse(store, blobId, streamForStore);

  return new Response(streamForResponse, {
    headers: responseHeaders,
  });
}
