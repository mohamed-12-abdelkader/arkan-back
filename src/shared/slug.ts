export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = slugify(base) || 'item';
  let i = 0;
  while (await exists(i === 0 ? slug : `${slug}-${i}`)) {
    i += 1;
  }
  return i === 0 ? slug : `${slug}-${i}`;
}
