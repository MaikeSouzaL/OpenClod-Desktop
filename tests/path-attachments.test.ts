import { describe, expect, it } from 'vitest'
import {
  addPathAttachments,
  isInlineText,
  pathAttachment,
  pathPromptBlock,
  type PathAttachment
} from '../src/renderer/src/lib/path-attachments'

describe('path attachments', () => {
  it('takes the last segment of a Windows path and drops trailing separators', () => {
    const folder = pathAttachment('C:\\Users\\Administrator\\Desktop\\rea\\', 'folder')
    expect(folder).toMatchObject({
      kind: 'folder',
      name: 'rea',
      path: 'C:\\Users\\Administrator\\Desktop\\rea'
    })
    expect(folder?.id).toMatch(/^dir_/)
  })

  it('accepts files, forward slashes and blank input', () => {
    const file = pathAttachment('/home/user/tools/setup.exe', 'file')
    expect(file).toMatchObject({ kind: 'file', name: 'setup.exe', path: '/home/user/tools/setup.exe' })
    expect(file?.id).toMatch(/^file_/)
    expect(pathAttachment('   ', 'file')).toBeNull()
  })

  it('deduplicates paths case-insensitively and respects the limit', () => {
    const first = pathAttachment('C:\\Dados\\REA', 'folder')!
    const afterDuplicate = addPathAttachments([first], [{ path: 'c:\\dados\\rea\\', kind: 'folder' }], 8)
    expect(afterDuplicate).toHaveLength(1)

    const afterMore = addPathAttachments(
      [first],
      [
        { path: 'C:\\Dados\\outra', kind: 'folder' },
        { path: 'C:\\Dados\\setup.exe', kind: 'file' }
      ],
      2
    )
    expect(afterMore.map((item) => item.name)).toEqual(['REA', 'outra'])
  })

  it('returns the same array when nothing changes, so React can skip a render', () => {
    const items: PathAttachment[] = [pathAttachment('C:\\Dados\\rea', 'folder')!]
    expect(addPathAttachments(items, [], 8)).toBe(items)
    expect(addPathAttachments(items, [{ path: 'C:\\Dados\\rea', kind: 'folder' }], 8)).toBe(items)
  })

  it('only inlines known text types, never arbitrary binaries', () => {
    expect(isInlineText('nota.md', '')).toBe(true)
    expect(isInlineText('script.ts', 'text/plain')).toBe(true)
    expect(isInlineText('.gitignore', '')).toBe(true)
    expect(isInlineText('dados.json', 'application/json')).toBe(true)
    expect(isInlineText('setup.exe', 'application/x-msdownload')).toBe(false)
    expect(isInlineText('foto.png', 'image/png')).toBe(false)
    expect(isInlineText('backup.zip', 'application/zip')).toBe(false)
    expect(isInlineText('binario', 'application/octet-stream')).toBe(false)
  })

  it('writes a readable block that distinguishes folders and files', () => {
    const block = pathPromptBlock([
      pathAttachment('C:\\Users\\Administrator\\Desktop\\rea', 'folder')!,
      pathAttachment('C:\\Users\\Administrator\\Downloads\\WisprFlowInstaller.exe', 'file')!
    ])
    expect(block).toContain('Pastas e arquivos anexados pelo usuário')
    expect(block).toContain('- pasta "rea": `C:\\Users\\Administrator\\Desktop\\rea`')
    expect(block).toContain('- arquivo "WisprFlowInstaller.exe": `C:\\Users\\Administrator\\Downloads\\WisprFlowInstaller.exe`')
    expect(pathPromptBlock([])).toBe('')
  })
})
