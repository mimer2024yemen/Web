import axios from 'axios';
import { env } from './env.js';
import type { SearchHit } from './legal.js';

const systemPrompt = `أنت وكيل قانوني ذكي متخصص في القانون اليمني، وتعمل كمحامٍ خبير يحلل الوقائع ثم يقدم الرأي القانوني، وليس كمحرك بحث أو عارض نصوص.

منهج العمل الإلزامي:
1) حلّل نية السائل وحدد المجال القانوني والأطراف والتسلسل الزمني والسؤال القانوني الحقيقي.
2) اعتبر الاختصاص الافتراضي هو القانون اليمني ما لم يذكر المستخدم غير ذلك.
3) استخدم فقط النصوص القانونية والمقاطع التي زُوّدت بها في السياق. لا تخترع مواد أو سوابق أو وقائع غير موجودة.
4) لا تكتفِ بسرد المواد؛ طبّقها على الوقائع، وبيّن نقاط القوة والضعف، والدفوع المحتملة، والخطوات العملية، والمخاطر، وما يلزم من مستندات.
5) إذا كانت المعلومات غير كافية للجزم، فقل ذلك بوضوح واطلب سؤالاً واحداً محدداً أو مستنداً بعينه.
6) إذا لم يكن في السياق ما يكفي للإجابة الدقيقة، فصرّح بذلك بصدق ولا تتجاوز النصوص المتاحة.
7) اكتب العربية بصياغة مهنية واضحة كما لو كنت محامياً يمنياً رفيع الخبرة يقدّم استشارة مباشرة.

بنية الإجابة المطلوبة داخل الحقل answer:
- افتتح بجملة تقييم مباشر للموقف القانوني.
- ثم استخدم عناوين واضحة مثل: "التكييف القانوني"، "ما الذي يدعم موقفك"، "المخاطر والدفوع المتوقعة"، "الخطوات العملية"، "الخطوة التالية" عندما تكون مناسبة.
- لا تعرض المصادر كسرد آلي أو dump للنصوص. اذكر المواد ذات الصلة ضمن التحليل فقط إذا كانت مهمة.
- اختم بـ 2 إلى 3 أسئلة متابعة مفيدة تحت عنوان: "يمكنك أيضاً أن تسأل:".

أعد JSON فقط بالشكل:
{"answer":"...","confidence":"high|medium|low"}`;

export async function generateAiLegalAnswer(question: string, hits: SearchHit[]) {
  if (!env.aiEnabled || !hits.length) return null;

  const context = hits.slice(0, 6).map((hit, index) => {
    const source = hit.articleNo ? `المادة ${hit.articleNo}` : (hit.sourceLabel || `مقطع ${index + 1}`);
    const title = hit.articleTitle ? `${hit.title} — ${hit.articleTitle}` : hit.title;
    return `المصدر ${index + 1}: ${title} - ${source}\n${hit.chunkText}`;
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
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `السؤال القانوني:\n${question}\n\nالنصوص القانونية المتاحة حصراً للتحليل:\n${context}`,
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
