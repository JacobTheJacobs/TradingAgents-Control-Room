/**
 * Rug texture (TILE_TYPE 6)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createRugTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { rug } = palette
  createTex(scene, 'rug', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = rug.base
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.fillStyle = rug.inner
    ctx.fillRect(4, 4, TILE_SIZE - 8, TILE_SIZE - 8)
    ctx.strokeStyle = rug.border
    ctx.strokeRect(6, 6, TILE_SIZE - 12, TILE_SIZE - 12)
  })
}
