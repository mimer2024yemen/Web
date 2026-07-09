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
  'ما', 'ماذا', 'كيف', 'هل', 'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'ثم', 'عند', 'بعد', 'قبل', 'أو', 'او', 'و', 'يا', 'اذا', 'إذا', 'أن', 'ان', 'لكن', 'فإن', 'فان', 'ضمن', 'حول', 'لدى', 'بين', 'كما', 'تم', 'قد', 'حقوق', 'حق', 'واجب', 'واجبات', 'بشأن', 'بخصوص'
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
  const normalized = normalizeArabic(question);
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !arabicStopWords.has(item));
  const unique = [...new Set(tokens)].slice(0, 8);
  return unique.map((term) => `${term}*`).join(' OR ');
}

export function rankHits(question: string, hits: SearchHit[]) {
  const normalizedQuestion = normalizeArabic(question);
  const articleNo = extractArticleNumber(question);
  return hits
    .map((hit) => {
      let score = hit.score;
      const normalizedChunk = normalizeArabic(hit.chunkText);
      const overlap = normalizedQuestion.split(' ').filter((token) => token && normalizedChunk.includes(token)).length;
      score += overlap * 0.45;
      if (articleNo && hit.articleNo === articleNo) score += 9;
      if (/فصل|تعسف|انهاء|إنهاء/.test(question) && /فصل|تعسف|انهاء|إنهاء/.test(hit.chunkText)) score += 1.2;
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

export function buildDeterministicAnswer(question: string, hits: SearchHit[]) {
  if (!hits.length) {
    return {
      answer: 'لم أجد في قاعدة البيانات القانونية الحالية نصاً مباشراً يكفي للإجابة بدقة على هذا السؤال. يمكنك رفع القانون أو اللائحة ذات الصلة، أو إعادة صياغة السؤال بشكل أكثر تحديداً مثل رقم المادة أو اسم النظام.',
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

  const intro = 'بعد مراجعة النصوص القانونية المتاحة في قاعدة البيانات، هذه هي المواد أو المقاطع الأقرب لسؤالك. التكييف النهائي لأي نزاع يظل مرتبطاً بالوقائع الكاملة والعقود واللوائح التنفيذية ذات الصلة.';
  const legalPoints = selected.map((hit, index) => {
    const sourceLabel = hit.articleNo ? `المادة ${hit.articleNo}` : (hit.sourceLabel || 'مقطع قانوني');
    return `${index + 1}) ${sourceLabel} من ${hit.title}: «${extractQuotedSnippet(hit.chunkText)}»`;
  }).join('\n');

  const conclusion = 'الخلاصة القانونية: يُبنى الجواب العملي على النصوص المسترجعة أعلاه، مع ضرورة قراءة المادة كاملة وربطها ببقية المواد العامة والاستثناءات والإجراءات الشكلية إن وجدت.';

  return {
    answer: `${intro}\n\n${legalPoints}\n\n${conclusion}`,
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
