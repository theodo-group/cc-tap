import { createReadStream } from 'fs'
import { createInterface } from 'readline'

/** Map with a concurrency cap */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Stream a JSONL file line by line; malformed lines and a missing file are skipped */
export async function readJSONLLines(
  filePath: string,
  cb: (line: Record<string, unknown>) => void
): Promise<void> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        cb(JSON.parse(line))
      } catch { /* skip malformed */ }
    }
  } catch { /* file missing */ }
}
