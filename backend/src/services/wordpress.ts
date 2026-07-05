import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

export type WordPressPublishInput = {
  title: string;
  content: string;
  excerpt?: string;
  slug?: string;
  seoTitle?: string;
  seoDescription?: string;
  categories?: string[];
  tags?: string[];
  categoryIds?: number[];
  tagIds?: number[];
  featuredImage?: { source: string; fileName?: string; mimeType?: string } | null;
  status?: 'draft' | 'publish' | 'future';
  date?: string | null;
};

function makeAuth(username: string, appPassword: string) {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}

function wpApi(baseUrl: string, endpoint: string) {
  return `${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/${endpoint.replace(/^\//, '')}`;
}

async function fetchTermId(baseUrl: string, headers: Record<string, string>, taxonomy: 'categories' | 'tags', name: string) {
  const existing = await axios.get(wpApi(baseUrl, `${taxonomy}?search=${encodeURIComponent(name)}`), { headers, timeout: 15000 });
  const found = Array.isArray(existing.data) ? existing.data.find((item) => String(item.name).toLowerCase() === name.toLowerCase()) : null;
  if (found?.id) return Number(found.id);
  const created = await axios.post(wpApi(baseUrl, taxonomy), { name }, { headers, timeout: 15000 });
  return Number(created.data.id);
}

async function loadBinary(featuredImage: NonNullable<WordPressPublishInput['featuredImage']>) {
  if (/^https?:\/\//.test(featuredImage.source)) {
    const response = await axios.get<ArrayBuffer>(featuredImage.source, { responseType: 'arraybuffer', timeout: 20000 });
    const ext = path.extname(new URL(featuredImage.source).pathname) || '.jpg';
    return {
      buffer: Buffer.from(response.data),
      fileName: featuredImage.fileName ?? `featured${ext}`,
      mimeType: featuredImage.mimeType ?? response.headers['content-type'] ?? 'image/jpeg',
    };
  }

  const stat = await fs.promises.stat(featuredImage.source);
  if (!stat.isFile()) throw new Error('Featured image source is not a file');
  return {
    buffer: await fs.promises.readFile(featuredImage.source),
    fileName: featuredImage.fileName ?? path.basename(featuredImage.source),
    mimeType: featuredImage.mimeType ?? 'image/jpeg',
  };
}

async function uploadFeaturedMedia(baseUrl: string, headers: Record<string, string>, featuredImage: NonNullable<WordPressPublishInput['featuredImage']>) {
  const file = await loadBinary(featuredImage);
  const response = await axios.post(
    wpApi(baseUrl, 'media'),
    file.buffer,
    {
      headers: {
        ...headers,
        'Content-Type': file.mimeType,
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
      },
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  );
  return Number(response.data.id);
}

export async function testWordPressConnection(baseUrl: string, username?: string, appPassword?: string) {
  const headers: Record<string, string> = {};
  if (username && appPassword) headers.Authorization = makeAuth(username, appPassword);
  const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/wp-json`, { headers, timeout: 10000 });
  const me = username && appPassword
    ? await axios.get(`${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/users/me?context=edit`, { headers, timeout: 10000 })
    : null;
  return { root: response.data, user: me?.data ?? null };
}

export async function syncWordPressTaxonomies(
  baseUrl: string,
  username: string,
  appPassword: string,
  categories: string[],
  tags: string[],
) {
  const headers = {
    Authorization: makeAuth(username, appPassword),
    'Content-Type': 'application/json',
  };
  const categoryIds: number[] = [];
  const tagIds: number[] = [];

  for (const category of categories.filter(Boolean)) categoryIds.push(await fetchTermId(baseUrl, headers, 'categories', category));
  for (const tag of tags.filter(Boolean)) tagIds.push(await fetchTermId(baseUrl, headers, 'tags', tag));

  return { categoryIds, tagIds };
}

export async function publishToWordPress(
  baseUrl: string,
  username: string,
  appPassword: string,
  payload: WordPressPublishInput,
) {
  const headers = {
    Authorization: makeAuth(username, appPassword),
    'Content-Type': 'application/json',
  };

  const syncedTerms = await syncWordPressTaxonomies(baseUrl, username, appPassword, payload.categories ?? [], payload.tags ?? []);
  const featuredMedia = payload.featuredImage ? await uploadFeaturedMedia(baseUrl, headers, payload.featuredImage) : undefined;

  const response = await axios.post(
    wpApi(baseUrl, 'posts'),
    {
      title: payload.title,
      content: payload.content,
      excerpt: payload.excerpt,
      slug: payload.slug,
      status: payload.status ?? 'publish',
      date: payload.date || undefined,
      categories: payload.categoryIds?.length ? payload.categoryIds : syncedTerms.categoryIds,
      tags: payload.tagIds?.length ? payload.tagIds : syncedTerms.tagIds,
      featured_media: featuredMedia,
      meta: {
        yoast_wpseo_title: payload.seoTitle,
        yoast_wpseo_metadesc: payload.seoDescription,
        rank_math_title: payload.seoTitle,
        rank_math_description: payload.seoDescription,
      },
    },
    { headers, timeout: 30000 },
  );
  return { ...response.data, categoryIds: syncedTerms.categoryIds, tagIds: syncedTerms.tagIds, featuredMedia };
}
