import sharp from 'sharp'
import type { ImagePart } from '../../shared/types.js'

/**
 * Pictures shown in the chat only (ToolResult.preview): what a tool read when the model gets its text instead, such as
 * the image an OCR read or the pages of a scanned PDF. They are kept with the session, so they stay small.
 */
const PREVIEW_WIDTH = 1_200
const PREVIEW_HEIGHT = 1_600
const PREVIEW_QUALITY = 70

/** A downscaled JPEG of an image file, or null: a preview never makes the tool that wanted it fail. */
export async function previewImage(file: string, label: string): Promise<ImagePart | null> {
  try {
    const data = await sharp(file)
      .rotate()
      .resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: PREVIEW_QUALITY })
      .toBuffer()
    return { type: 'image', mediaType: 'image/jpeg', data: data.toString('base64'), label }
  } catch {
    return null
  }
}
