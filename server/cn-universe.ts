import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const universeSchema = z.object({
  warning: z.string(),
  securities: z.array(
    z.object({
      code: z.string().regex(/^(sh|sz)\.\d{6}$/),
      rationale: z.string().min(1),
    }),
  ).min(30).max(50),
})

export type CnPrototypeUniverse = z.infer<typeof universeSchema>

const defaultPath = fileURLToPath(
  new URL('../acquisition/cn-prototype-universe.json', import.meta.url),
)

export async function loadCnPrototypeUniverse(
  filePath = defaultPath,
): Promise<CnPrototypeUniverse> {
  return universeSchema.parse(JSON.parse(await readFile(filePath, 'utf8')))
}
