/**
 * Cabinet texture (TILE_TYPE 10)
 */
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createCabinetTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { props } = palette
  createTex(scene, 'cabinet', 32, 48, (ctx) => {
    // Drop shadow
    ctx.fillStyle = props.shadow
    ctx.fillRect(7, 12, 24, 38)
    // Main body
    ctx.fillStyle = props.metal
    ctx.fillRect(4, 8, 24, 40)
    ctx.fillStyle = props.metalDark
    ctx.fillRect(4, 8, 24, 2)
    ctx.fillStyle = props.metalLight
    ctx.fillRect(6, 12, 20, 10)
    ctx.fillRect(6, 24, 20, 10)
    ctx.fillRect(6, 36, 20, 10)
    ctx.fillStyle = props.plasticLight
    ctx.fillRect(14, 14, 4, 2)
    ctx.fillRect(14, 26, 4, 2)
    ctx.fillRect(14, 38, 4, 2)
  })
}
