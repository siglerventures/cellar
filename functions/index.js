'use strict';

// Cellar — scanLabel Cloud Function
// -----------------------------------------------------------------------------
// A callable HTTPS function that takes a compressed wine-label photo, sends it to
// the Anthropic vision API, and returns the extracted details PLUS a prediction of
// whether the wine fits Phil's palate. The API key never touches the client — it
// lives in a Firebase secret (ANTHROPIC_API_KEY).
//
// Deploy:  firebase functions:secrets:set ANTHROPIC_API_KEY   (paste the sk-ant-... key)
//          firebase deploy --only functions:scanLabel --project philinity-893d2
// -----------------------------------------------------------------------------

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const Anthropic = require('@anthropic-ai/sdk');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Keep this codebase off other apps' functions in the shared project.
setGlobalOptions({ region: 'us-central1', maxInstances: 5 });

// The current Claude vision model. Swap to 'claude-sonnet-5' for a cheaper scan.
const MODEL = 'claude-opus-5';

// Phil's palate model (kept in sync with the app's §8 "The Palate" bars).
const PALATE = [
  "Earthy, savory, structured European reds with real weight — bottle age welcome,",
  "smoke and leather a bonus. Light/tart/funky and SO2-sharp lose. Nebbiolo has",
  "underperformed (his two lowest scores). Proven wins: Amarone, Châteauneuf-du-Pape,",
  "Rioja, Bordeaux, Brunello. Core drivers: earthy/savory/dried-fruit (95%),",
  "body/weight/concentration (88%), structure — tannin & acid grip (82%),",
  "bottle age / tertiary complexity (78%), smoke/leather/meat (70% — a 7 can become a 9).",
  "Turn-offs: excess SO2 and light/tart/funky natural wines (14%)."
].join(' ');

const PROMPT = [
  "This is a label photo from a home bar/cellar collection — usually WINE, but",
  "possibly bourbon/whiskey, tequila, vodka, a mixer/liqueur, or a cigar band.",
  "Respond with ONLY a JSON object (no markdown, no backticks, no preamble)",
  "with exactly these keys:",
  '- "kind": one of "wine", "bourbon", "tequila", "vodka", "mixer", "cigar"',
  '- "name": the wine\'s name or cuvée (NOT the producer)',
  '- "producer": the producer / winery',
  '- "region": appellation + area/country',
  '- "grape": grape variety or blend. If the label states a varietal breakdown',
  '  with percentages (often on the back label, e.g. "GRAPE VARIETIES: 65%',
  '  Grenache Noir, 15% Mourvèdre, 15% Syrah…"), return that FULL breakdown as',
  '  one string: "65% Grenache Noir, 15% Mourvèdre, 15% Syrah, others 5%".',
  '  Otherwise the variety or blend name alone (e.g. "Grenache blend").',
  '- "vintage": for wine, the year as a string — EMPTY STRING if no year is shown',
  '  (never write "NV"). For tequila: the class (Blanco/Reposado/Añejo/Extra',
  '  Añejo/Cristalino). For whiskey: the age statement or bottling year if shown.',
  '- "abv": alcohol percentage as a number-only string (no % sign)',
  '- "predLow": your predicted score for THIS taster, low end, a number 1-10 (.5 steps ok)',
  '- "predHigh": predicted score, high end, a number 1-10',
  '- "fit": one of "love", "like", "maybe", "pass"',
  '- "verdict": one short sentence (max ~22 words) on whether it fits the taster and why',
  "Use an empty string for any label field you cannot read. ALWAYS provide predLow,",
  "predHigh, fit, and verdict as your best judgment from the label + the palate below.",
  "IMPORTANT — the palate below describes the taster's WINE preferences. Apply it",
  "only when kind is wine. For bourbon/tequila/vodka/mixers judge on general",
  "quality, typicity, age statements, proof, and reputation (they enjoy quality",
  "spirits — full-flavored, well-made; no strong known biases yet). For cigars",
  "judge on construction, origin, and reputation. Still ALWAYS give predLow,",
  "predHigh, fit, and verdict.",
  "",
  "The taster's WINE palate: " + PALATE
].join('\n');

function parseModelJson(message) {
  const text = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];
  return JSON.parse(cleaned);
}

function coerceScore(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.max(1, Math.min(10, n));
}

// ── cellarScanMenu: photograph a restaurant wine list or shop shelf ──────────
// Input: { images:[{base64, mediaType}] (max 4), collectionSummary }.
// Reads every wine visible, ranks them for THIS taster using the palate +
// their real rating history, and returns { ok, data:{context, summary, wines} }
// with wines best-first. Deploy scoped:
//   firebase deploy --only functions:cellar:cellarScanMenu --project philinity-893d2
exports.cellarScanMenu = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, memory: '512MiB', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to scan.');
    }
    let images = (request.data && request.data.images) || [];
    if (!Array.isArray(images)) images = [];
    images = images.filter((i) => i && typeof i.base64 === 'string' && i.base64).slice(0, 4);
    if (!images.length) {
      throw new HttpsError('invalid-argument', 'No images supplied.');
    }
    let summary = (request.data && request.data.collectionSummary) || [];
    if (!Array.isArray(summary)) summary = [];
    let summaryJson = JSON.stringify(summary.slice(0, 500));
    if (summaryJson.length > 40000) summaryJson = summaryJson.slice(0, 40000);

    const prompt = [
      "These photo(s) show a RESTAURANT MENU/DRINKS LIST or a STORE SHELF — usually",
      "wine, but possibly bourbon/whiskey, tequila, vodka, or cocktails/mixers.",
      "Identify every bottle/pour you can read (name, vintage and price if shown),",
      "then rank them for THIS taster — best first. For WINE use the palate below",
      "plus their real rating history (collection JSON: 'opened' items have actual",
      "1-10 ratings) — prefer wines like their proven wins, downrank known misses.",
      "For SPIRITS judge on quality, typicity, proof/age statements and reputation",
      "(they enjoy full-flavored, well-made spirits; no strong biases known yet).",
      "Respond with ONLY a JSON object (no markdown, no backticks):",
      '{"context":"menu" or "shelf",',
      ' "summary": one sentence naming the single top pick and why it fits,',
      ' "wines":[{"name":"","kind":"wine"|"bourbon"|"tequila"|"vodka"|"mixer","vintage":"","price":"","predLow":n,"predHigh":n,',
      '  "fit":"love"|"like"|"maybe"|"pass","verdict":"max ~18 words why"}]}',
      "Include at most 12 wines (the most relevant), best first. predLow/predHigh are",
      "predicted scores 1-10 (.5 steps ok). Use empty strings for unreadable fields.",
      "",
      "The taster's palate: " + PALATE,
      "",
      "Their collection & ratings (JSON):",
      summaryJson
    ].join('\n');

    const content = images.map((i) => ({
      type: 'image',
      source: { type: 'base64', media_type: i.mediaType || 'image/jpeg', data: i.base64 }
    }));
    content.push({ type: 'text', text: prompt });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content }]
      });
      const parsed = parseModelJson(message);
      const wines = (Array.isArray(parsed.wines) ? parsed.wines : []).slice(0, 12).map((w) => ({
        name: String(w.name || '').trim(),
        kind: ['wine','bourbon','tequila','vodka','mixer','cigar'].includes(w.kind) ? w.kind : 'wine',
        vintage: String(w.vintage || '').trim(),
        price: String(w.price || '').trim(),
        predLow: coerceScore(w.predLow),
        predHigh: coerceScore(w.predHigh),
        fit: ['love', 'like', 'maybe', 'pass'].includes(w.fit) ? w.fit : 'maybe',
        verdict: String(w.verdict || '').trim()
      })).filter((w) => w.name);
      return {
        ok: true,
        data: {
          context: parsed.context === 'shelf' ? 'shelf' : 'menu',
          summary: String(parsed.summary || '').trim(),
          wines
        }
      };
    } catch (err) {
      console.error('[cellarScanMenu] failed:', err);
      return { ok: false, error: (err && err.message) || 'Scan failed — try a closer shot.' };
    }
  }
);

// ── cellarAskAI: Cellar's Q&A + add-a-bottle over the real collection ────────
// Input: { question, collectionSummary, attachedPhotos } (photos are uploaded by
// the client; attachedPhotos is just a count so the model knows pics exist).
// Returns { ok, answer } — the answer may end with a JSON action block
// {"action":"add","bottle":{...}} which the client executes.
exports.cellarAskAI = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, memory: '512MiB', timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to ask about the cellar.');
    }
    const question = request.data && String(request.data.question || '').trim();
    if (!question) {
      throw new HttpsError('invalid-argument', 'No question supplied.');
    }
    let summary = (request.data && request.data.collectionSummary) || [];
    if (!Array.isArray(summary)) summary = [];
    // Keep the prompt bounded even if the client sends a huge cellar.
    let summaryJson = JSON.stringify(summary.slice(0, 500));
    if (summaryJson.length > 60000) summaryJson = summaryJson.slice(0, 60000);

    const attachedPhotos = Number(request.data && request.data.attachedPhotos) || 0;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            "You are the sommelier for a private wine cellar app. Answer the owner's",
            "question using ONLY the collection data below (their real bottles) plus",
            "general wine knowledge. Be specific — name actual bottles from the data.",
            "Counts must be computed from the data. Keep it concise (a short paragraph",
            "or a brief list), plain text, no markdown headers.",
            "",
            "SPECIAL CASE — adding bottles: if the owner is asking you to ADD or LOG one",
            "or more bottles (e.g. \"add the 2019 La Gerla Brunello, 8.5, earthy, buy",
            "again\" — or a pasted store receipt listing several wines with prices),",
            "reply with ONE short confirmation sentence followed by a JSON block PER",
            "BOTTLE, each on its own lines, exactly this shape (no markdown fences):",
            '{"action":"add","bottle":{"name":"","producer":"","region":"","grape":"",',
            '"vintage":"","abv":"","status":"opened","qty":1,"score":null,"tag":null,',
            '"buyAgain":false,"notes":"","price":null,"vendor":"","kind":"wine"}}',
            "Rules per block: status is \"opened\" if they tasted/rated it, else",
            "\"cellared\" (receipt purchases are cellared); score is 1-10 in 0.5 steps",
            "or null; tag is ONE of earthy, smoke, big, aged, fruity, light, funky,",
            "off — or null; price is the per-bottle number without $ (use the pre-tax",
            "line price; do NOT add tax lines or totals as bottles); vendor is the",
            "store/restaurant name if stated; kind is wine unless it's clearly bourbon,",
            "tequila, vodka, a mixer, or a cigar; put impressions or context into notes;",
            "leave unknown fields empty/null. Never invent a rating they didn't give.",
            "Fill region/grape/producer from your wine knowledge when the name makes",
            "them unambiguous.",
            (attachedPhotos > 0 ? "The owner attached " + attachedPhotos + " photo(s) which the app will save onto the new bottle automatically." : ""),
            "For ordinary questions, do NOT output any JSON — plain text only.",
            "",
            "The owner's palate: " + PALATE,
            "",
            "Collection (JSON; status 'cellared' = unopened on hand, 'opened' = already",
            "tasted & rated; rating is out of 10; buyAgain = flagged to reorder):",
            summaryJson,
            "",
            "Owner's message: " + question
          ].filter(Boolean).join('\n')
        }]
      });
      const answer = (message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { ok: true, answer };
    } catch (err) {
      console.error('[cellarAskAI] failed:', err);
      return { ok: false, error: (err && err.message) || 'Ask AI failed — try again.' };
    }
  }
);

exports.scanLabel = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, memory: '512MiB', timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to scan labels.');
    }
    const imageBase64 = request.data && request.data.imageBase64;
    const mediaType = (request.data && request.data.mediaType) || 'image/jpeg';
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new HttpsError('invalid-argument', 'No image supplied.');
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: PROMPT }
            ]
          }
        ]
      });

      const w = parseModelJson(message);
      const fit = ['love', 'like', 'maybe', 'pass'].includes(w.fit) ? w.fit : 'maybe';
      const data = {
        kind: ['wine','bourbon','tequila','vodka','mixer','cigar'].includes(w.kind) ? w.kind : 'wine',
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        region: String(w.region || '').trim(),
        grape: String(w.grape || '').trim(),
        vintage: String(w.vintage || '').trim(),
        abv: String(w.abv == null ? '' : w.abv).replace('%', '').trim(),
        predLow: coerceScore(w.predLow),
        predHigh: coerceScore(w.predHigh),
        fit,
        verdict: String(w.verdict || '').trim()
      };
      return { ok: true, data };
    } catch (err) {
      console.error('[scanLabel] failed:', err);
      return { ok: false, error: (err && err.message) || 'Scan failed — enter details manually.' };
    }
  }
);
