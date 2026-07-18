/**
 * Floor texture (TILE_TYPE 0)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createFloorTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { floor } = palette

  createTex(scene, 'floor', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = floor.base
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)

    // Subtle checkered pattern
    ctx.fillStyle = floor.tileA
    ctx.fillRect(0, 0, TILE_SIZE / 2, TILE_SIZE / 2)
    ctx.fillStyle = floor.tileB
    ctx.fillRect(TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE / 2)

    // Beveling for depth
    ctx.fillStyle = floor.bevelLight
    ctx.fillRect(0, 0, TILE_SIZE, 1)
    ctx.fillRect(0, 0, 1, TILE_SIZE)
    ctx.fillStyle = floor.bevelDark
    ctx.fillRect(0, TILE_SIZE - 1, TILE_SIZE, 1)
    ctx.fillRect(TILE_SIZE - 1, 0, 1, TILE_SIZE)

    // Soft marble veins (fixed positions for consistency)
    ctx.fillStyle = floor.vein
    ctx.fillRect(4, 6, 2, 1)
    ctx.fillRect(12, 10, 2, 1)
    ctx.fillRect(7, 14, 2, 1)
    ctx.fillRect(14, 4, 2, 1)
  })
}
