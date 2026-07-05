import axios from 'axios';

export type WordPressPublishInput = {
  title: string;
  content: string;
  excerpt?: string;
  slug?: string;
  seoTitle?: string;
  seoDescription?: string;
  categories?: number[];
  tags?: number[];
  status?: 'draft' | 'publish' | 'future';
  date?: string | null;
};

function makeAuth(username: string, appPassword: string) {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}

export async function testWordPressConnection(baseUrl: string, username?: string, appPassword?: string) {
  const headers: Record<string, string> = {};
  if (username && appPassword) headers.Authorization = makeAuth(username, appPassword);
  const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/wp-json`, { headers, timeout: 10000 });
  return response.data;
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

  const response = await axios.post(
    `${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts`,
    {
      title: payload.title,
      content: payload.content,
      excerpt: payload.excerpt,
      slug: payload.slug,
      status: payload.status ?? 'publish',
      date: payload.date || undefined,
      categories: payload.categories ?? [],
      tags: payload.tags ?? [],
      meta: {
        yoast_wpseo_title: payload.seoTitle,
        yoast_wpseo_metadesc: payload.seoDescription,
        rank_math_title: payload.seoTitle,
        rank_math_description: payload.seoDescription,
      },
    },
    { headers, timeout: 15000 },
  );
  return response.data;
}
