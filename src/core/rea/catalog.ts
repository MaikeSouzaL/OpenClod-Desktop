import fs from 'node:fs'
import path from 'node:path'

/**
 * The REA tool catalog the app registers without starting REA: `resources/rea/catalog.json`, written by
 * scripts/embed-rea.mjs from `tools/list` of the bundled server. Tool names, descriptions and schemas come from REA's
 * own listing; the families below only group them for the system prompt and the docs.
 */

export interface ReaCatalogTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface ReaCatalog {
  version: string
  schemaProfile: string
  instructions: string
  tools: ReaCatalogTool[]
}

export const CATALOG_FILE = 'catalog.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Parses the catalog JSON; entries without a usable name or schema are dropped. Null when the file is not a catalog. */
export function parseReaCatalog(raw: unknown): ReaCatalog | null {
  if (!isRecord(raw) || !Array.isArray(raw.tools) || typeof raw.version !== 'string') return null
  const tools: ReaCatalogTool[] = []
  for (const item of raw.tools) {
    if (!isRecord(item) || typeof item.name !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(item.name)) continue
    tools.push({
      name: item.name,
      title: typeof item.title === 'string' ? item.title : undefined,
      description: typeof item.description === 'string' ? item.description : '',
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} },
      annotations: isRecord(item.annotations) ? item.annotations : undefined
    })
  }
  return {
    version: raw.version,
    schemaProfile: typeof raw.schemaProfile === 'string' ? raw.schemaProfile : 'compact',
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    tools
  }
}

export function loadReaCatalog(reaDir: string): ReaCatalog | null {
  try {
    return parseReaCatalog(JSON.parse(fs.readFileSync(path.join(reaDir, CATALOG_FILE), 'utf8')))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Families                                                            */
/* ------------------------------------------------------------------ */

export interface ReaFamily {
  id: string
  label: string
  test: RegExp
}

/** First match wins; the order puts the specific runtimes before the generic native words. */
export const REA_FAMILIES: ReaFamily[] = [
  { id: 'frida', label: 'Frida (instrumentação em execução)', test: /frida/ },
  { id: 'adb', label: 'Android em aparelho (ADB)', test: /adb/ },
  { id: 'android', label: 'Android/HarmonyOS estático (APK, DEX, recursos, JEB)', test: /android|apk|apktool|jeb|harmony|dart|flutter/ },
  { id: 'apple', label: 'Apple (Mach-O, Swift, Objective-C, plist, Interface Builder)', test: /apple|macho|swift|objc|plist|interface_builder|keyed_archive|asset_catalog|ips|dylib|native_ui/ },
  { id: 'web', label: 'Web, JavaScript e Electron', test: /web|browser|javascript|electron|bundle|source|wasm|webmcp|cutter_sessions/ },
  { id: 'managed', label: '.NET e código gerenciado', test: /managed/ },
  { id: 'debug', label: 'Depuradores e consoles (rizin, gdb, Cutter)', test: /rizin|gdb|cutter/ },
  { id: 'evidence', label: 'Evidências, reconstrução e comparação', test: /evidence|reconstruction|unknown|compare|verify|correlate|changed_behavior|environment_bundle|obligation|coverage/ },
  { id: 'capture', label: 'Capturas (processo, rede, pcap, sinais, falhas)', test: /capture|pcap|packet|signal|crash|process/ },
  { id: 'artifacts', label: 'Artefatos, firmware e formatos empacotados', test: /artifact|firmware|devicetree|desktop_application|pyc|beam|il2cpp|gpu|model_artifact|kernel_module|evm|sqlite|go_binary|rust|elf|entropy|signature|pe_/ },
  {
    id: 'native',
    label: 'Binários nativos (Ghidra, Kuna, IDA, Hopper: funções, pseudocódigo, xrefs, strings)',
    test: /binary|procedure|function|address|xref|string|segment|name|bookmark|comment|bytes|call|native|decompile|document|navigation|architectures|objdump|layout|feature|analysis/
  }
]

export function reaFamilyOf(tool: string): ReaFamily | undefined {
  return REA_FAMILIES.find((family) => family.test.test(tool))
}

/** Tool names per family, in catalog order; tools no family claims go to "outros". */
export function groupReaTools(tools: Array<Pick<ReaCatalogTool, 'name'>>): Array<{ id: string; label: string; tools: string[] }> {
  const groups = new Map<string, { id: string; label: string; tools: string[] }>()
  for (const family of REA_FAMILIES) groups.set(family.id, { id: family.id, label: family.label, tools: [] })
  groups.set('outros', { id: 'outros', label: 'Outros', tools: [] })
  for (const tool of tools) groups.get(reaFamilyOf(tool.name)?.id ?? 'outros')!.tools.push(tool.name)
  return [...groups.values()].filter((group) => group.tools.length)
}
