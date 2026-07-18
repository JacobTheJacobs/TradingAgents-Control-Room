/**
 * Window texture (TILE_TYPE 12)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createWindowTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { window } = palette
  createTex(scene, 'window', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = window.frame
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.fillStyle = window.glass
    ctx.fillRect(4, 4, TILE_SIZE - 8, TILE_SIZE - 8)
    ctx.strokeStyle = window.mullion
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(TILE_SIZE / 2, 4)
    ctx.lineTo(TILE_SIZE / 2, TILE_SIZE - 4)
    ctx.moveTo(4, TILE_SIZE / 2)
    ctx.lineTo(TILE_SIZE - 4, TILE_SIZE / 2)
    ctx.stroke()

    ctx.fillStyle = window.glare
    ctx.fillRect(5, 5, 1, TILE_SIZE - 10)
  })
}
