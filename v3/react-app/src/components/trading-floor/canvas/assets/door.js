/**
 * Door texture (TILE_TYPE 9)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createDoorTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { wood, props } = palette
  createTex(scene, 'door', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = wood.dark
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.fillStyle = wood.main
    ctx.fillRect(2, 0, TILE_SIZE - 4, TILE_SIZE)
    ctx.fillStyle = props.warning
    ctx.beginPath()
    ctx.arc(TILE_SIZE - 8, TILE_SIZE / 2, 3, 0, Math.PI * 2)
    ctx.fill()
  })
}
