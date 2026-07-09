import path from 'node:path';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';

export type LegalChunk = {
  articleNo: string | null;
  articleTitle: string | null;
  sourceLabel: string | null;
  text: string;
};

export type SearchHit = {
  id: string;
  documentId: string;
  title: string;
  fileName: string;
  articleNo: string | null;
  articleTitle: string | null;
  sourceLabel: string | null;
  chunkText: string;
  score: number;
};

const arabicStopWords = new Set([
  'ما', 'ماذا', 'كيف', 'هل', 'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'ثم', 'عند', 'بعد', 'قبل', 'أو', 'او', 'و', 'يا', 'اذا', 'إذا', 'أن', 'ان', 'لكن', 'فإن', 'فان', 'ضمن', 'حول', 'لدى', 'بين', 'كما', 'تم', 'قد', 'حقوق', 'حق', 'واجب', 'واجبات', 'بشأن', 'بخصوص', 'وفق', 'وفقا', 'وفقاً', 'حول', 'الى', 'التي', 'الذي', 'علي', 'على', 'عند'
]);

export function toWesternDigits(value: string) {
  return value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

export function normalizeArabic(text: string) {
  return toWesternDigits(text)
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeToken(token: string) {
  return normalizeArabic(token).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function stripArabicPrefix(token: string) {
  if (token.startsWith('ال') && token.length > 4) return token.slice(2);
  return token;
}

export function extractSearchTerms(question: string) {
  const normalized = normalizeArabic(question);
  const rawTokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => normalizeToken(item))
    .filter((item) => item.length >= 2);

  const expanded = new Set<string>();
  for (const token of rawTokens) {
    if (arabicStopWords.has(token)) continue;
    expanded.add(token);
    const withoutAl = stripArabicPrefix(token);
    if (withoutAl.length >= 2 && !arabicStopWords.has(withoutAl)) expanded.add(withoutAl);
  }

  return [...expanded].slice(0, 12);
}

export function extractArticleNumber(question: string) {
  const match = toWesternDigits(question).match(/(?:الماده|المادة|ماده|مادة|article)\s*\(?\s*([0-9]+)\s*\)?/i);
  return match?.[1] ?? null;
}

function cleanText(text: string) {
  return text
    .replace(/\r/g, '')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

function splitLongText(text: string, limit = 1400) {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  const paragraphs = text.split(/\n\n+/).map((item) => item.trim()).filter(Boolean);
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).trim().length > limit && current.trim()) {
      parts.push(current.trim());
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`.trim();
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text];
}

export async function extractTextFromFile(buffer: Buffer, fileName: string, mimeType: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType.includes('pdf') || ext === '.pdf') {
    const result = await pdf(buffer);
    return cleanText(result.text || '');
  }
  if (mimeType.includes('word') || ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value || '');
  }
  return cleanText(buffer.toString('utf8'));
}

export function buildChunksFromLegalText(text: string): LegalChunk[] {
  const source = cleanText(text);
  if (!source) return [];

  const articleRegex = /(^|\n)\s*(?:المادة|مادة|Article)\s*\(?\s*([0-9٠-٩]+)\s*\)?\s*[-:.,،]?\s*(.*)$/gim;
  const matches = [...source.matchAll(articleRegex)];

  if (matches.length) {
    const chunks: LegalChunk[] = [];
    for (let i = 0; i < matches.length; i += 1) {
      const current = matches[i];
      const start = current.index ?? 0;
      const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
      const articleNo = toWesternDigits(current[2] ?? '').trim();
      const title = (current[3] ?? '').split('\n')[0].trim() || null;
      const articleBody = source.slice(start, nextStart).trim();
      for (const part of splitLongText(articleBody)) {
        chunks.push({
          articleNo: articleNo || null,
          articleTitle: title,
          sourceLabel: articleNo ? `المادة ${articleNo}` : null,
          text: part,
        });
      }
    }
    return chunks;
  }

  const paragraphs = source.split(/\n\n+/).map((item) => item.trim()).filter(Boolean);
  if (!paragraphs.length) return [];

  const grouped: LegalChunk[] = [];
  let current = '';
  let index = 1;
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).trim().length > 1400 && current.trim()) {
      grouped.push({ articleNo: null, articleTitle: null, sourceLabel: `مقطع ${index}`, text: current.trim() });
      current = paragraph;
      index += 1;
    } else {
      current = `${current}\n\n${paragraph}`.trim();
    }
  }
  if (current.trim()) grouped.push({ articleNo: null, articleTitle: null, sourceLabel: `مقطع ${index}`, text: current.trim() });
  return grouped;
}

export function buildSearchQuery(question: string) {
  const unique = extractSearchTerms(question);
  return unique.map((term) => `${term}*`).join(' OR ');
}

export function rankHits(question: string, hits: SearchHit[]) {
  const searchTerms = extractSearchTerms(question);
  const articleNo = extractArticleNumber(question);
  return hits
    .map((hit) => {
      let score = hit.score;
      const normalizedChunk = normalizeArabic(hit.chunkText);
      const overlap = searchTerms.filter((token) => normalizedChunk.includes(token)).length;
      score += overlap * 0.65;
      if (articleNo && hit.articleNo === articleNo) score += 9;
      if (/فصل|تعسف|انهاء|إنهاء/.test(question) && /فصل|تعسف|انهاء|إنهاء/.test(hit.chunkText)) score += 1.2;
      if (/اجر|أجر|راتب/.test(question) && /اجر|أجر|راتب/.test(hit.chunkText)) score += 1;
      return { ...hit, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function summarizeDocument(text: string) {
  return cleanText(text).slice(0, 500);
}

export function buildConversationTitle(question: string) {
  const compact = question.replace(/\s+/g, ' ').trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

export function extractQuotedSnippet(text: string, maxLength = 320) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

function stripArticleLead(text: string) {
  return text
    .replace(/^(?:المادة|مادة|article)\s*\(?\s*[0-9٠-٩]+\s*\)?\s*[-:.,،]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDirectConclusion(hit: SearchHit) {
  const label = hit.articleNo ? `المادة ${hit.articleNo}` : (hit.sourceLabel || 'النص الأقرب');
  const holding = stripArticleLead(hit.chunkText).replace(/[.،؛:\s]+$/g, '');
  if (!holding) {
    return `بحسب ${label} من ${hit.title}، يوجد نص قانوني قريب من السؤال ويستحق التطبيق على الوقائع التفصيلية.`;
  }
  return `بحسب ${label} من ${hit.title}، ${holding}`;
}

export function buildDeterministicAnswer(question: string, hits: SearchHit[]) {
  if (!hits.length) {
    return {
      answer: 'بعد فحص الوثائق الحالية، لا توجد أمامي نصوص قانونية كافية تسمح بإعطاء جواب دقيق وآمن على هذا السؤال. الأفضل أن ترفع القانون أو العقد أو اللائحة المرتبطة مباشرة بالموضوع، أو أن تعيد صياغة السؤال بصيغة أكثر تحديداً مثل: رقم المادة، اسم القانون، نوع الدعوى، أو صفة كل طرف في النزاع.\n\nالخطوة التالية:\nزوّدني باسم النظام القانوني أو المستند المرتبط بالقضية لأبني عليه تحليلاً أدق.\n\nيمكنك أيضاً أن تسأل:\n- ما الوثيقة المناسبة التي يجب رفعها لهذه المسألة؟\n- كيف أصيغ السؤال القانوني بصيغة أدق؟\n- ما البيانات التي يحتاجها التحليل القانوني قبل إبداء الرأي؟',
      citations: [],
    };
  }

  const uniqueArticles = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = `${hit.documentId}:${hit.articleNo ?? hit.id}`;
    if (!uniqueArticles.has(key)) uniqueArticles.set(key, hit);
    if (uniqueArticles.size >= 4) break;
  }
  const selected = [...uniqueArticles.values()];
  const primary = selected[0];

  const legalPoints = selected.map((hit, index) => {
    const sourceLabel = hit.articleNo ? `المادة ${hit.articleNo}` : (hit.sourceLabel || 'مقطع قانوني');
    return `${index + 1}) ${sourceLabel} من ${hit.title}: «${extractQuotedSnippet(hit.chunkText)}»`;
  }).join('\n');

  return {
    answer: `الخلاصة المباشرة:\n${buildDirectConclusion(primary)}.\n\nالتكييف القانوني الأولي:\nالسؤال المطروح يتعلق بتطبيق النصوص المسترجعة على الوقائع العملية، لذلك يجب قراءة المادة أو المقطع في سياقه الكامل مع التحقق من صفة الأطراف والتسلسل الزمني والمستندات المؤيدة قبل الجزم النهائي.\n\nالنصوص أو المقاطع الأقرب:\n${legalPoints}\n\nما الذي يدعم موقفك:\nكلما كانت الوقائع المطروحة متطابقة مع شروط النصوص أعلاه، زادت قوة الاستناد إليها في الاستشارة أو المذكرة أو المرافعة.\n\nالمخاطر والدفوع المتوقعة:\nقد تتغير النتيجة إذا وُجد نص خاص يقيّد النص العام، أو استثناء قانوني، أو نقص في الإثبات، أو شرط إجرائي لم يكتمل.\n\nالخطوات العملية:\n1) راجع المادة كاملة ضمن القانون الأصلي وليس المقتطف فقط.\n2) حدّد أسماء الأطراف وصفاتهم وتاريخ الواقعة بدقة.\n3) أرفق أي عقد أو حكم أو إشعار أو محضر متعلق بالموضوع لتحليل أقوى وأكثر تحديداً.\n\nالخطوة التالية:\nإذا أردت، أستطيع الآن تحويل هذه النصوص إلى رأي قانوني أكثر دقة عند تزويدي بالوقائع التفصيلية أو المستند الأساسي المرتبط بالنزاع.\n\nيمكنك أيضاً أن تسأل:\n- ما الدفوع التي قد يثيرها الطرف الآخر؟\n- ما المستندات اللازمة لتقوية هذا الموقف؟\n- ما الإجراء القضائي أو الإداري الأنسب في هذه الحالة؟`,
    citations: selected.map((hit) => ({
      documentId: hit.documentId,
      title: hit.title,
      fileName: hit.fileName,
      articleNo: hit.articleNo,
      articleTitle: hit.articleTitle,
      sourceLabel: hit.sourceLabel,
      excerpt: extractQuotedSnippet(hit.chunkText, 420),
    })),
  };
}
