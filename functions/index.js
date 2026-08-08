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
  "This is a wine bottle label. Respond with ONLY a JSON object (no markdown, no",
  "backticks, no preamble) with exactly these keys:",
  '- "name": the wine\'s name or cuvée (NOT the producer)',
  '- "producer": the producer / winery',
  '- "region": appellation + area/country',
  '- "grape": grape variety or blend',
  '- "vintage": year as a string (use "NV" if non-vintage)',
  '- "abv": alcohol percentage as a number-only string (no % sign)',
  '- "predLow": your predicted score for THIS taster, low end, a number 1-10 (.5 steps ok)',
  '- "predHigh": predicted score, high end, a number 1-10',
  '- "fit": one of "love", "like", "maybe", "pass"',
  '- "verdict": one short sentence (max ~22 words) on whether it fits the taster and why',
  "Use an empty string for any label field you cannot read. ALWAYS provide predLow,",
  "predHigh, fit, and verdict as your best judgment from the label + the palate below.",
  "",
  "The taster's palate: " + PALATE
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

// ── askAI: natural-language questions answered from the user's real collection ──
// Input: { question, collectionSummary } — the client builds the compact summary
// from already-loaded bottles, so this reads nothing server-side. Returns
// { ok, answer } as plain text. Deploy scoped:
//   firebase deploy --only functions:askAI --project philinity-893d2
exports.askAI = onCall(
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
            "The owner's palate: " + PALATE,
            "",
            "Collection (JSON; status 'cellared' = unopened on hand, 'opened' = already",
            "tasted & rated; rating is out of 10; buyAgain = flagged to reorder):",
            summaryJson,
            "",
            "Question: " + question
          ].join('\n')
        }]
      });
      const answer = (message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { ok: true, answer };
    } catch (err) {
      console.error('[askAI] failed:', err);
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
