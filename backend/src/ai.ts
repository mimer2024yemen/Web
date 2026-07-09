import axios from 'axios';
import { env } from './env.js';
import type { SearchHit } from './legal.js';

export async function generateAiLegalAnswer(question: string, hits: SearchHit[]) {
  if (!env.aiEnabled || !hits.length) return null;

  const context = hits.slice(0, 6).map((hit, index) => {
    const source = hit.articleNo ? `المادة ${hit.articleNo}` : (hit.sourceLabel || `مقطع ${index + 1}`);
    return `المصدر ${index + 1}: ${hit.title} - ${source}\n${hit.chunkText}`;
  }).join('\n\n');

  const response = await axios.post(
    `${env.aiApiUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: env.aiModel,
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'أنت مساعد قانوني عربي دقيق. أجب فقط اعتماداً على النصوص المتاحة. أعد JSON بالشكل: {"answer":"...","confidence":"high|medium|low"}. يجب أن تكون الإجابة مهنية وواضحة وتذكر المواد ذات الصلة دون اختلاق أي نص غير موجود.'
        },
        {
          role: 'user',
          content: `السؤال:\n${question}\n\nالنصوص القانونية المتاحة:\n${context}`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${env.aiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    },
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
      return {
        answer: parsed.answer.trim(),
        confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'medium',
      };
    }
  } catch {
    return null;
  }

  return null;
}
